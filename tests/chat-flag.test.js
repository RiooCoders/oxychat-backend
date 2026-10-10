'use strict';
/**
 * Test fitur "Ganti model saat pesan ditandai" (content-flag + chat.service + relay).
 * TANPA express: fetch di-mock, relay dites lewat http server mini.
 * Jalankan: node --test tests/chat-flag.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

Object.assign(process.env, {
  NODE_ENV: 'test',
  GROQ_API_KEY: 'key-groq',
  NVIDIA_API_KEY: 'key-nvidia',
  MISTRAL_API_KEY: 'key-mistral',
  PERPLEXITY_API_KEY: 'key-perplexity',
  OPENROUTER_API_KEY: 'key-openrouter',
  GEMINI_API_KEY: 'key-gemini',
  OPENROUTER_MODEL: 'openrouter/auto',
  UPSTREAM_TIMEOUT_MS: '2000',
});

const chatService = require('../src/services/chat.service');
const { runChatAndRespond } = require('../src/utils/http-chat-relay');
const flag = require('../src/utils/content-flag');

const realFetch = globalThis.fetch;
let calls = [];
let script = [];

const enc = new TextEncoder();

function jsonRes(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
function okCompletion(content) {
  return jsonRes(200, {
    id: 'c1',
    object: 'chat.completion',
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  });
}
function sseRes(chunks) {
  const rs = new ReadableStream({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(typeof c === 'string' ? enc.encode(c) : c);
      ctrl.close();
    },
  });
  return new Response(rs, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
function mockFetch(steps) {
  calls = [];
  script = [...steps];
  globalThis.fetch = async (url, opts) => {
    const u = new URL(typeof url === 'string' ? url : url.url);
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    calls.push({ host: u.hostname, model: body.model, body });
    const next = script.shift();
    if (!next) throw new Error(`fetch tak terduga ke ${u.hostname} (${body.model})`);
    return typeof next === 'function' ? next(body) : next;
  };
}
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

const userMsg = [{ role: 'user', content: 'halo' }];
const POLICY_400 = {
  error: {
    message: 'Your request was rejected as a result of our safety system.',
    type: 'invalid_request_error',
    code: 'content_policy_violation',
  },
};
const FILTER_CHUNK = 'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n';
const ROLE_CHUNK = 'data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n';
const TEXT_CHUNK = 'data: {"choices":[{"delta":{"content":"hai"},"finish_reason":null}]}\n\n';
const DONE_CHUNK = 'data: [DONE]\n\n';

/* ------------------------------ unit: deteksi ------------------------------ */

test('looksFlaggedUpstream: sinyal moderation/safety asli = true', () => {
  assert.equal(flag.looksFlaggedUpstream(400, JSON.stringify(POLICY_400)), true);
  // OpenRouter: 403 + metadata.reasons (HARUS menang atas cabang "403 = auth")
  assert.equal(
    flag.looksFlaggedUpstream(
      403,
      JSON.stringify({ error: { message: 'Your chosen model requires moderation and your input was flagged', code: 403, metadata: { reasons: ['harassment'], flagged_input: 'x' } } })
    ),
    true
  );
  assert.equal(flag.looksFlaggedUpstream(403, JSON.stringify({ error: { code: 403, metadata: { reasons: ['violence'] } } })), true);
  // Gemini: error dibungkus array, blokir karena SAFETY
  assert.equal(
    flag.looksFlaggedUpstream(400, JSON.stringify([{ error: { code: 400, message: 'Candidate was blocked due to SAFETY', status: 'INVALID_ARGUMENT' } }])),
    true
  );
  assert.equal(flag.looksFlaggedUpstream(400, JSON.stringify({ error: { code: 'content_filter', message: 'blocked' } })), true);
  assert.equal(flag.looksFlaggedUpstream(422, 'Request violates our usage policy'), true);
  assert.equal(flag.looksFlaggedUpstream(400, JSON.stringify({ error: { message: 'HARM_CATEGORY_DANGEROUS_CONTENT' } })), true);
});

test('looksFlaggedUpstream: error biasa BUKAN "ditandai"', () => {
  assert.equal(flag.looksFlaggedUpstream(401, JSON.stringify({ error: { message: 'Invalid API key' } })), false);
  assert.equal(flag.looksFlaggedUpstream(403, JSON.stringify({ error: { message: 'Invalid API key provided, authentication failed' } })), false);
  assert.equal(flag.looksFlaggedUpstream(400, JSON.stringify({ error: { message: 'messages must be a non-empty array' } })), false);
  assert.equal(flag.looksFlaggedUpstream(400, JSON.stringify({ error: { message: 'The model `x` has been decommissioned' } })), false);
  assert.equal(flag.looksFlaggedUpstream(400, JSON.stringify({ error: { message: "'safety_identifier' is not a valid parameter" } })), false);
  assert.equal(flag.looksFlaggedUpstream(500, JSON.stringify({ error: { message: 'content_filter' } })), false); // status bukan kandidat
  assert.equal(flag.looksFlaggedUpstream(429, 'moderation rate limit'), false);
  assert.equal(flag.looksFlaggedUpstream(400, ''), false);
  assert.equal(flag.looksFlaggedUpstream(400, '<html>Bad Request</html>'), false);
});

test('isFlaggedCompletion: hanya content_filter + isi kosong', () => {
  const mk = (finish, content) => ({ choices: [{ finish_reason: finish, message: { role: 'assistant', content } }] });
  assert.equal(flag.isFlaggedCompletion(mk('content_filter', '')), true);
  assert.equal(flag.isFlaggedCompletion(mk('content_filter', null)), true);
  assert.equal(flag.isFlaggedCompletion(mk('content_filter', '   ')), true);
  assert.equal(flag.isFlaggedCompletion(mk('content_filter', 'jawaban sebagian')), false);
  assert.equal(flag.isFlaggedCompletion(mk('stop', '')), false);
  assert.equal(flag.isFlaggedCompletion({ choices: [] }), false);
  assert.equal(flag.isFlaggedCompletion(null), false);
});

test('judgeSseLine: keputusan per baris SSE', () => {
  assert.equal(flag.judgeSseLine(': ping'), null);
  assert.equal(flag.judgeSseLine('event: message'), null);
  assert.equal(flag.judgeSseLine('data: '), null);
  assert.equal(flag.judgeSseLine('data: {bukan json'), null);
  assert.equal(flag.judgeSseLine('data: [DONE]'), 'ok');
  assert.equal(flag.judgeSseLine('data: {"choices":[{"delta":{"content":""},"finish_reason":null}]}'), null);
  assert.equal(flag.judgeSseLine('data: {"choices":[{"delta":{"content":"a"}}]}'), 'ok');
  assert.equal(flag.judgeSseLine('data: {"choices":[{"delta":{"reasoning_content":"mikir"}}]}'), 'ok');
  assert.equal(flag.judgeSseLine('data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}'), 'flagged');
  assert.equal(flag.judgeSseLine('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}'), 'ok');
  assert.equal(flag.judgeSseLine('data: {"error":{"message":"x"}}'), 'ok');
});

test('peekStreamForFlag: stream normal diputar ulang UTUH (byte-per-byte), termasuk chunk terbelah di tengah baris', async () => {
  const full = ROLE_CHUNK + TEXT_CHUNK + 'data: {"choices":[{"delta":{"content":" dunia"}}]}\n\n' + DONE_CHUNK;
  const bytes = enc.encode(full);
  const cut1 = 30;
  const cut2 = ROLE_CHUNK.length + 20; // terbelah di tengah baris data kedua
  const res = sseRes([bytes.slice(0, cut1), bytes.slice(cut1, cut2), bytes.slice(cut2)]);
  const peeked = await flag.peekStreamForFlag(res);
  assert.equal(peeked.flagged, false);
  assert.equal(await peeked.response.text(), full);
});

test('peekStreamForFlag: content_filter tanpa isi = flagged, stream upstream ditutup', async () => {
  let cancelled = false;
  const rs = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(enc.encode(ROLE_CHUNK));
      ctrl.enqueue(enc.encode(FILTER_CHUNK));
    },
    cancel() {
      cancelled = true;
    },
  });
  const peeked = await flag.peekStreamForFlag(new Response(rs, { status: 200 }));
  assert.equal(peeked.flagged, true);
  assert.equal(peeked.response, null);
  assert.equal(cancelled, true);
});

test('peekStreamForFlag: model thinking (reasoning dulu) & stream kosong tidak dianggap flagged', async () => {
  const think = 'data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n\n';
  const p1 = await flag.peekStreamForFlag(sseRes([think, TEXT_CHUNK, DONE_CHUNK]));
  assert.equal(p1.flagged, false);
  assert.equal(await p1.response.text(), think + TEXT_CHUNK + DONE_CHUNK);
  const p2 = await flag.peekStreamForFlag(sseRes([]));
  assert.equal(p2.flagged, false);
  assert.equal(await p2.response.text(), '');
});

test('peekStreamForFlag: stream putus sebelum ada isi -> error dilempar ke pemanggil', async () => {
  const rs = new ReadableStream({
    start(ctrl) {
      ctrl.error(new Error('koneksi putus'));
    },
  });
  await assert.rejects(() => flag.peekStreamForFlag(new Response(rs, { status: 200 })), /koneksi putus/);
});

/* --------------------------- integrasi: chat.service --------------------------- */

test('app (default): HTTP 400 moderation di model utama -> pindah ke model lain + ditandai switched', async () => {
  mockFetch([jsonRes(400, POLICY_400), okCompletion('aman')]);
  const r = await chatService.handleChat({ model: 'llama-3.3-70b-versatile', messages: userMsg, stream: false });
  assert.equal(r.data.choices[0].message.content, 'aman');
  assert.deepEqual(r.switched, { reason: 'content_flagged' });
  assert.deepEqual(r.data.vaeltrix.switched, { reason: 'content_flagged' });
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].model, calls[1].model);
});

test('app: switch_on_flag=false -> obrolan DIJEDA (CONTENT_FLAGGED), tanpa mencoba model lain', async () => {
  mockFetch([jsonRes(400, POLICY_400)]);
  await assert.rejects(
    () => chatService.handleChat({ model: 'llama-3.3-70b-versatile', messages: userMsg, stream: false, switch_on_flag: false }),
    (err) => {
      assert.equal(err.code, 'CONTENT_FLAGGED');
      assert.equal(err.status, 422);
      assert.match(err.message, /dijeda/);
      assert.match(err.message, /Kemampuan/);
      return true;
    }
  );
  assert.equal(calls.length, 1);
});

test('api (/v1): default TIDAK ganti model; opt-in switch_on_flag=true baru ganti', async () => {
  mockFetch([jsonRes(400, POLICY_400)]);
  await assert.rejects(
    () => chatService.handleChat({ model: 'llama-3.3-70b-versatile', messages: userMsg, stream: false }, { surface: 'api' }),
    (err) => {
      assert.equal(err.code, 'CONTENT_FLAGGED');
      assert.match(err.message, /switch_on_flag/);
      return true;
    }
  );
  assert.equal(calls.length, 1);

  mockFetch([jsonRes(400, POLICY_400), okCompletion('aman')]);
  const r = await chatService.handleChat(
    { model: 'llama-3.3-70b-versatile', messages: userMsg, stream: false, switch_on_flag: true },
    { surface: 'api' }
  );
  assert.equal(r.data.choices[0].message.content, 'aman');
  assert.equal(calls.length, 2);
});

test('HTTP 200 + finish_reason content_filter kosong (non-stream) dianggap ditandai -> pindah model', async () => {
  const filtered = jsonRes(200, {
    id: 'x',
    object: 'chat.completion',
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'content_filter' }],
  });
  mockFetch([filtered, okCompletion('lolos')]);
  const r = await chatService.handleChat({ model: 'llama-3.3-70b-versatile', messages: userMsg, stream: false });
  assert.equal(r.data.choices[0].message.content, 'lolos');
  assert.deepEqual(r.switched, { reason: 'content_flagged' });
});

test('stream: chunk pertama content_filter -> model utama dibuang, jawaban dari model lain utuh', async () => {
  mockFetch([sseRes([ROLE_CHUNK, FILTER_CHUNK, DONE_CHUNK]), sseRes([ROLE_CHUNK, TEXT_CHUNK, DONE_CHUNK])]);
  const r = await chatService.handleChat({ model: 'llama-3.3-70b-versatile', messages: userMsg, stream: true });
  assert.equal(r.stream, true);
  assert.deepEqual(r.switched, { reason: 'content_flagged' });
  const text = await r.upstream.text();
  assert.ok(text.includes('"content":"hai"'));
  assert.ok(text.includes('[DONE]'));
  assert.equal(calls.length, 2);
});

test('stream normal TANPA ditandai: tidak ada switched, isi stream utuh', async () => {
  mockFetch([sseRes([ROLE_CHUNK, TEXT_CHUNK, DONE_CHUNK])]);
  const r = await chatService.handleChat({ model: 'llama-3.3-70b-versatile', messages: userMsg, stream: true });
  assert.equal(r.switched, null);
  assert.equal(await r.upstream.text(), ROLE_CHUNK + TEXT_CHUNK + DONE_CHUNK);
});

test('semua kandidat menandai pesan -> CONTENT_FLAGGED dengan pesan yang jelas', async () => {
  mockFetch([jsonRes(400, POLICY_400), jsonRes(400, POLICY_400), jsonRes(400, POLICY_400), jsonRes(400, POLICY_400), jsonRes(400, POLICY_400)]);
  await assert.rejects(
    () => chatService.handleChat({ model: 'llama-3.3-70b-versatile', messages: userMsg, stream: false }),
    (err) => {
      assert.equal(err.code, 'CONTENT_FLAGGED');
      assert.match(err.message, /tidak ada model cadangan/);
      return true;
    }
  );
});

test('error biasa (400 invalid, bukan moderation) TIDAK memicu ganti model', async () => {
  mockFetch([jsonRes(400, { error: { message: 'messages must be a non-empty array' } })]);
  await assert.rejects(
    () => chatService.handleChat({ model: 'llama-3.3-70b-versatile', messages: userMsg, stream: false }),
    (err) => err.code === 'PROVIDER_INVALID_REQUEST'
  );
  assert.equal(calls.length, 1);
});

test('rate limit tetap fallback seperti biasa dan TIDAK ditandai switched', async () => {
  mockFetch([jsonRes(429, { error: { message: 'rate limit' } }), okCompletion('dari saudara')]);
  const r = await chatService.handleChat({ model: 'llama-3.3-70b-versatile', messages: userMsg, stream: false });
  assert.equal(r.data.choices[0].message.content, 'dari saudara');
  assert.equal(r.switched, null);
  assert.equal(r.data.vaeltrix, undefined);
});

test('spectrax: Gemini menandai pesan -> NVIDIA menjawab (switched); switch off -> dijeda', async () => {
  mockFetch([jsonRes(400, POLICY_400), okCompletion('dari nvidia')]);
  const r = await chatService.handleChat({ model: 'spectrax', messages: userMsg, stream: false });
  assert.equal(r.data.choices[0].message.content, 'dari nvidia');
  assert.deepEqual(r.switched, { reason: 'content_flagged' });
  assert.match(calls[0].host, /googleapis/);
  assert.match(calls[1].host, /nvidia/);

  mockFetch([jsonRes(400, POLICY_400)]);
  await assert.rejects(
    () => chatService.handleChat({ model: 'spectrax', messages: userMsg, stream: false, switch_on_flag: false }),
    (err) => err.code === 'CONTENT_FLAGGED'
  );
  assert.equal(calls.length, 1);
});

test('validasi: switch_on_flag non-boolean ditolak 400', async () => {
  await assert.rejects(
    () => chatService.handleChat({ model: 'llama-3.3-70b-versatile', messages: userMsg, stream: false, switch_on_flag: 'ya' }),
    (err) => err.status === 400 && /switch_on_flag/.test(err.message)
  );
});

test('resolveSwitchOnFlag: default per surface + override eksplisit', () => {
  const f = chatService.resolveSwitchOnFlag;
  assert.equal(f({}, 'app'), true);
  assert.equal(f({}, 'api'), false);
  assert.equal(f({ switch_on_flag: false }, 'app'), false);
  assert.equal(f({ switch_on_flag: true }, 'api'), true);
});

/* ------------------------------ relay: event SSE ------------------------------ */

function startRelayServer(factory, opts) {
  const server = http.createServer((req, res) => {
    // shim minimal API express yang dipakai relay
    res.status = (c) => {
      res.statusCode = c;
      return res;
    };
    res.set = (h) => {
      for (const k of Object.keys(h)) res.setHeader(k, h[k]);
      return res;
    };
    res.json = (o) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(o));
    };
    req.body = { stream: opts.stream };
    runChatAndRespond(req, res, factory, { enableEvents: true });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
async function getFrom(server) {
  const { port } = server.address();
  const r = await realFetch(`http://127.0.0.1:${port}/`);
  return { status: r.status, text: await r.text() };
}

test('relay: stream dengan switched -> chunk {"vaeltrix":{"switched":...}} muncul SEBELUM isi jawaban', async () => {
  const upstream = sseRes([ROLE_CHUNK, TEXT_CHUNK, DONE_CHUNK]);
  const server = await startRelayServer(async () => ({ stream: true, upstream, keepThinking: false, switched: { reason: 'content_flagged' } }), { stream: true });
  try {
    const { status, text } = await getFrom(server);
    assert.equal(status, 200);
    const iSwitched = text.indexOf('"switched"');
    const iContent = text.indexOf('"content":"hai"');
    assert.ok(iSwitched > -1 && iContent > -1 && iSwitched < iContent, text);
    assert.ok(text.includes('{"vaeltrix":{"switched":{"reason":"content_flagged"}}}'));
  } finally {
    server.close();
  }
});

test('relay: stream tanpa switched -> tidak ada chunk vaeltrix tambahan', async () => {
  const upstream = sseRes([ROLE_CHUNK, TEXT_CHUNK, DONE_CHUNK]);
  const server = await startRelayServer(async () => ({ stream: true, upstream, keepThinking: false, switched: null }), { stream: true });
  try {
    const { text } = await getFrom(server);
    assert.ok(!text.includes('vaeltrix'));
    assert.ok(text.includes('"content":"hai"'));
  } finally {
    server.close();
  }
});

test('relay: CONTENT_FLAGGED saat stream belum terbuka -> HTTP 422 JSON dengan error.code', async () => {
  const server = await startRelayServer(async () => {
    throw chatServiceError();
  }, { stream: true });
  try {
    const { status, text } = await getFrom(server);
    assert.equal(status, 422);
    assert.equal(JSON.parse(text).error.code, 'CONTENT_FLAGGED');
  } finally {
    server.close();
  }
});

function chatServiceError() {
  return flag.contentFlaggedError('groq');
}
