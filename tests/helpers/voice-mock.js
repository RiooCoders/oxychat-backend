'use strict';

/**
 * Tiruan ElevenLabs (daftar suara, TTS, STT Scribe) + Groq Whisper dalam SATU server HTTP lokal.
 * Perilakunya bisa diatur per skenario lewat `state` (lihat createVoiceMock). Dipakai voice*.test.js.
 */
const http = require('node:http');

const AUDIO = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2400, 7)]); // "mp3" palsu, cukup besar utk lolos cek audio kosong

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return { fields: {}, files: {} };
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const fields = {};
  const files = {};
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const next = buf.indexOf(boundary, pos + boundary.length);
    if (next === -1) break;
    const part = buf.subarray(pos + boundary.length + 2, next - 2); // buang CRLF di awal & akhir
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const head = part.subarray(0, headerEnd).toString('utf8');
      const body = part.subarray(headerEnd + 4);
      const name = (/name="([^"]+)"/.exec(head) || [])[1];
      const filename = (/filename="([^"]*)"/.exec(head) || [])[1];
      const ctype = (/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1];
      if (name) {
        if (filename !== undefined) files[name] = { filename, contentType: ctype, size: body.length };
        else fields[name] = body.toString('utf8');
      }
    }
    pos = next;
  }
  return { fields, files };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function createVoiceMock() {
  const state = {
    voices: 'ok', // ok | paged | permission | unusual | server_error | legacy | auth_fail
    perVoice: {}, // voiceId -> ok | not_found | paid | hang | slow | rate_limited | unusual | quota
    rejectModels: new Set(), // model_id yang ditolak TTS (400 model_not_found)
    rejectLanguageCode: false,
    stt: 'ok', // ok | auth_fail
    groq: 'ok', // ok | silence | hallucination | auth_fail | rate_limited | server_error
    groqRejectModels: new Set(),
    ttsCalls: [],
    sttCalls: [],
    groqCalls: [],
    voiceListCalls: 0,
    closedEarly: 0,
  };
  let port = 0;

  const voice = (id, name, gender, extra = {}) => ({
    voice_id: id,
    name,
    category: 'premade',
    labels: { gender, accent: 'american', descriptive: 'warm', use_case: 'conversational' },
    preview_url: `http://127.0.0.1:${port}/preview/${id}.mp3`,
    ...extra,
  });
  const allVoices = () => [
    voice('v-eric', 'Eric', 'male'), voice('v-laura', 'Laura', 'female'), voice('v-roger', 'Roger', 'male'), voice('v-sarah', 'Sarah', 'female'),
    voice('v-george', 'George', 'male'), voice('v-jessica', 'Jessica', 'female'), voice('v-brian', 'Brian', 'male'), voice('v-alice', 'Alice', 'female'),
    voice('v-matilda', 'Matilda', 'female'), voice('v-charlie', 'Charlie', 'male'),
    voice('v-kaelen', 'Kaelen - Amateur Warrior', 'male', { labels: { gender: 'male', use_case: 'characters_animation' } }),
    voice('v-rachel', 'Rachel', 'female', { category: 'cloned' }),
    voice('v-pro', 'Pro Voice', 'male', { category: 'professional' }),
  ];

  const json = (res, status, obj, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.on('close', () => {
      if (!res.writableEnded) state.closedEarly += 1;
    });

    // ---------- ElevenLabs ----------
    if (url.pathname === '/v2/voices' || url.pathname === '/v1/voices') {
      state.voiceListCalls += 1;
      if (state.voices === 'auth_fail' || req.headers['xi-api-key'] !== 'xi-test-key') {
        return json(res, 401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } });
      }
      if (state.voices === 'permission') return json(res, 401, { detail: { status: 'missing_permissions', message: 'The API key you used is missing the permission voices_read.' } });
      if (state.voices === 'unusual') return json(res, 401, { detail: { status: 'detected_unusual_activity', message: 'Unusual activity detected. Free Tier usage disabled.' } });
      if (state.voices === 'server_error') return json(res, 500, { detail: { status: 'internal', message: 'boom' } });
      if (url.pathname === '/v2/voices' && state.voices === 'legacy') return json(res, 404, { detail: 'Not Found' });
      if (url.pathname === '/v2/voices' && state.voices === 'paged') {
        const list = allVoices();
        if (!url.searchParams.get('next_page_token')) return json(res, 200, { voices: list.slice(0, 5), has_more: true, next_page_token: 'p2' });
        return json(res, 200, { voices: list.slice(5), has_more: false, next_page_token: null });
      }
      return json(res, 200, url.pathname === '/v2/voices' ? { voices: allVoices(), has_more: false, total_count: allVoices().length, next_page_token: null } : { voices: allVoices() });
    }

    const ttsMatch = /^\/v1\/text-to-speech\/([^/]+)$/.exec(url.pathname);
    if (ttsMatch && req.method === 'POST') {
      const voiceId = decodeURIComponent(ttsMatch[1]);
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      state.ttsCalls.push({ voiceId, query: Object.fromEntries(url.searchParams), body, headers: req.headers });
      if (req.headers['xi-api-key'] !== 'xi-test-key') return json(res, 401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } });
      const behavior = state.perVoice[voiceId] || 'ok';
      if (behavior === 'hang') return; // sengaja tidak pernah menjawab
      if (behavior === 'not_found') return json(res, 404, { detail: { status: 'voice_not_found', message: `A voice with the voice_id ${voiceId} was not found.` } });
      if (behavior === 'paid') return json(res, 402, { detail: { status: 'paid_plan_required', message: 'Free users cannot use library voices via the API.' } });
      if (behavior === 'unusual') return json(res, 401, { detail: { status: 'detected_unusual_activity', message: 'Unusual activity detected. Free Tier usage disabled.' } });
      if (behavior === 'quota') return json(res, 401, { detail: { status: 'quota_exceeded', message: 'This request exceeds your quota of 10000.' } });
      if (behavior === 'rate_limited') return json(res, 429, { detail: { status: 'too_many_concurrent_requests', message: 'Too many concurrent requests' } }, { 'Retry-After': '3' });
      if (state.rejectModels.has(body.model_id)) return json(res, 400, { detail: { status: 'model_not_found', message: `The model ${body.model_id} is not available for text to speech.` } });
      if (state.rejectLanguageCode && body.language_code) {
        return json(res, 422, { detail: [{ loc: ['body', 'language_code'], msg: 'language_code is not supported for this model', type: 'value_error' }] });
      }
      const send = () => {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': AUDIO.length });
        res.end(AUDIO);
      };
      if (behavior === 'slow') return setTimeout(send, 800);
      return send();
    }

    if (url.pathname === '/v1/speech-to-text' && req.method === 'POST') {
      const raw = await readBody(req);
      state.sttCalls.push({ ...parseMultipart(raw, req.headers['content-type']), headers: req.headers });
      if (req.headers['xi-api-key'] !== 'xi-test-key' || state.stt === 'auth_fail') return json(res, 401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } });
      return json(res, 200, { language_code: 'ind', language_probability: 0.99, text: ' halo dari scribe ', words: [] });
    }

    // ---------- Groq Whisper ----------
    if (url.pathname === '/openai/v1/audio/transcriptions' && req.method === 'POST') {
      const raw = await readBody(req);
      const parsed = parseMultipart(raw, req.headers['content-type']);
      state.groqCalls.push({ ...parsed, headers: req.headers });
      if (req.headers.authorization !== 'Bearer key-groq' || state.groq === 'auth_fail') return json(res, 401, { error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } });
      if (state.groq === 'rate_limited') return json(res, 429, { error: { message: 'Rate limit reached', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }, { 'Retry-After': '7' });
      if (state.groq === 'server_error') return json(res, 500, { error: { message: 'internal error' } });
      if (state.groqRejectModels.has(parsed.fields.model)) {
        return json(res, 404, { error: { message: `The model \`${parsed.fields.model}\` does not exist or you do not have access to it.`, type: 'invalid_request_error', code: 'model_not_found' } });
      }
      if (state.groq === 'silence') return json(res, 200, { text: ' Terima kasih telah menonton', language: 'indonesian', segments: [{ text: ' Terima kasih telah menonton', no_speech_prob: 0.93, avg_logprob: -1.7 }] });
      if (state.groq === 'hallucination') return json(res, 200, { text: 'Thanks for watching!', language: 'english' });
      return json(res, 200, { text: ' halo dunia', language: 'indonesian', segments: [{ text: ' halo dunia', no_speech_prob: 0.01, avg_logprob: -0.2 }] });
    }

    json(res, 404, { detail: 'not found' });
  });

  return {
    server,
    state,
    audio: AUDIO,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(port); })),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
    get port() { return port; },
    reset() {
      state.voices = 'ok'; state.perVoice = {}; state.rejectModels = new Set(); state.rejectLanguageCode = false;
      state.stt = 'ok'; state.groq = 'ok'; state.groqRejectModels = new Set();
      state.ttsCalls.length = 0; state.sttCalls.length = 0; state.groqCalls.length = 0; state.voiceListCalls = 0; state.closedEarly = 0;
    },
  };
}

/** Byte rekaman palsu dengan header WebM asli (cukup untuk lolos deteksi format & batas minimal). */
function fakeWebm(size = 4096) {
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(size - 4, 9)]);
}

module.exports = { createVoiceMock, fakeWebm, parseMultipart };
