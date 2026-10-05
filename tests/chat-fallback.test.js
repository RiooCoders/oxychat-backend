'use strict';
/**
 * Test alur chat.service (kandidat fallback, terjemahan parameter thinking, pesan error)
 * + relay SSE stateful. TANPA express: fetch di-mock langsung, response SSE dialirkan lewat
 * http server mini. Jalankan: node --test tests/chat-fallback.test.js
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
  OPENROUTER_MODEL: 'openrouter/auto', // simulasi env deploy lama (berbayar)
  UPSTREAM_TIMEOUT_MS: '2000',
});

const chatService = require('../src/services/chat.service');
const { pipeSse } = require('../src/utils/http-chat-relay');

const realFetch = globalThis.fetch;
let calls = [];
let script = [];

function jsonRes(status, obj, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
function okCompletion(content, extra = {}) {
  return jsonRes(200, { id: 'c1', object: 'chat.completion', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }] });
}
function sseRes(lines) {
  const enc = new TextEncoder();
  const rs = new ReadableStream({
    start(ctrl) {
      for (const l of lines) ctrl.enqueue(enc.encode(l));
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

test('Groq kena 413 (TPM) -> coba model saudara di Groq, BUKAN langsung OpenRouter', async () => {
  mockFetch([
    jsonRes(413, { error: { message: 'Request too large for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Requested 9500', code: 'rate_limit_exceeded' } }),
    okCompletion('dari saudara'),
  ]);
  const r = await chatService.handleChat({ model: 'llama-3.3-70b-versatile', messages: userMsg, stream: false });
  assert.equal(r.data.choices[0].message.content, 'dari saudara');
  assert.deepEqual(calls.map((c) => [c.host, c.model]), [['api.groq.com', 'openai/gpt-oss-120b'], ['api.groq.com', 'openai/gpt-oss-20b']]);
});

test('semua kandidat gagal -> error yang muncul = error PROVIDER UTAMA (bukan "openrouter sedang tidak tersedia")', async () => {
  mockFetch([
    jsonRes(413, { error: { message: 'Request too large for model', code: 'rate_limit_exceeded' } }),
    jsonRes(429, { error: { message: 'Rate limit reached' } }),
    jsonRes(402, { error: { message: 'Insufficient credits' } }),
    jsonRes(500, { error: { message: 'boom' } }),
  ]);
  await assert.rejects(
    chatService.handleChat({ model: 'llama-3.3-70b-versatile', messages: userMsg, stream: false }),
    (err) => {
      assert.equal(err.code, 'PROVIDER_PAYLOAD_TOO_LARGE');
      assert.match(err.message, /groq/i);
      assert.match(err.message, /cadangan openrouter juga gagal/);
      assert.ok(!/^Provider openrouter sedang tidak tersedia/.test(err.message));
      return true;
    }
  );
  // urutan: groq 120b -> groq 20b -> openrouter (env lama "auto") -> openrouter/free
  assert.deepEqual(calls.map((c) => c.model), ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'openrouter/auto', 'openrouter/free']);
});

test('request SALAH (400) gak di-fallback: langsung dilempar, cuma 1 panggilan', async () => {
  mockFetch([jsonRes(400, { error: { message: 'messages: invalid shape' } })]);
  await assert.rejects(chatService.handleChat({ model: 'openai/gpt-oss-120b', messages: userMsg }), (e) => e.code === 'PROVIDER_INVALID_REQUEST');
  assert.equal(calls.length, 1);
});

test('decommissioned/deprecated dianggap model mati -> fallback jalan', async () => {
  mockFetch([
    jsonRes(400, { error: { message: 'The model `x` has been decommissioned and is no longer supported.', code: 'model_decommissioned' } }),
    okCompletion('ok via saudara'),
  ]);
  const r = await chatService.handleChat({ model: 'openai/gpt-oss-20b', messages: userMsg });
  assert.equal(r.data.choices[0].message.content, 'ok via saudara');
});

test('parameter thinking diterjemahin bener: gpt-oss (thinking OFF) -> include_reasoning:false, tanpa reasoning_format', async () => {
  mockFetch([okCompletion('hai')]);
  await chatService.handleChat({ model: 'llama-3.3-70b-versatile', messages: userMsg });
  const b = calls[0].body;
  assert.equal(b.include_reasoning, false);
  assert.equal(b.reasoning_format, undefined);
  assert.equal(b.reasoning_effort, undefined);
});

test('gpt-oss (thinking ON dari frontend lama: reasoning_effort + reasoning_format) -> format dibuang, effort valid', async () => {
  mockFetch([okCompletion('hai', { reasoning: 'mikir native' })]);
  const r = await chatService.handleChat({ model: 'llama-3.3-70b-versatile', messages: userMsg, reasoning_effort: 'high', reasoning_format: 'parsed' });
  const b = calls[0].body;
  assert.equal(b.reasoning_effort, 'high');
  assert.equal(b.include_reasoning, true);
  assert.equal(b.reasoning_format, undefined, 'gpt-oss gak support reasoning_format');
  assert.equal(r.data.choices[0].message.content, 'hai');
  assert.equal(r.data.choices[0].message.reasoning_content, 'mikir native', 'thinking dipisah ke field sendiri, bukan di content');
});

test('thinking OFF: reasoning native provider gak pernah nyampe ke client', async () => {
  mockFetch([okCompletion('<think>rahasia</think>jawaban', { reasoning: 'rahasia native', reasoning_content: 'rahasia2' })]);
  const r = await chatService.handleChat({ model: 'openai/gpt-oss-120b', messages: userMsg });
  const m = r.data.choices[0].message;
  assert.equal(m.content, 'jawaban');
  assert.equal(m.reasoning, undefined);
  assert.equal(m.reasoning_content, undefined);
});

test('qwen: public id 3.6 -> upstream 3.8; thinking OFF = effort none, ON = parsed', async () => {
  mockFetch([okCompletion('a'), okCompletion('b')]);
  await chatService.handleChat({ model: 'qwen/qwen3.6-27b', messages: userMsg });
  await chatService.handleChat({ model: 'qwen/qwen3.6-27b', messages: userMsg, show_thinking: true, reasoning_effort: 'low' });
  assert.equal(calls[0].model, 'qwen/qwen3.8-27b');
  assert.equal(calls[0].body.reasoning_effort, 'none');
  assert.equal(calls[1].body.reasoning_format, 'parsed');
  assert.equal(calls[1].body.reasoning_effort, 'low');
});

test('request bergambar: fallback gak boleh ke model Groq yang gak support gambar', async () => {
  const img = [{ role: 'user', content: [{ type: 'text', text: 'apa ini' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }];
  mockFetch([jsonRes(429, { error: { message: 'rate limit' } }), okCompletion('ok'), ]);
  const r = await chatService.handleChat({ model: 'qwen/qwen3.6-27b', messages: img });
  assert.equal(r.data.choices[0].message.content, 'ok');
  assert.deepEqual(calls.map((c) => c.model), ['qwen/qwen3.8-27b', 'qwen/qwen3.6-27b']);
});

// ---------- SSE end-to-end lewat pipeSse ----------
async function streamThroughRelay(upstreamLines, opts) {
  const server = http.createServer((req, res) => {
    res.status = (c) => ((res.statusCode = c), res);
    res.set = (h) => (Object.keys(h).forEach((k) => res.setHeader(k, h[k])), res);
    pipeSse(res, sseRes(upstreamLines), opts);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const resp = await realFetch(`http://127.0.0.1:${server.address().port}/`);
    return await resp.text();
  } finally {
    await new Promise((r) => server.close(r));
  }
}
function parseSse(text) {
  let content = '';
  let reasoning = '';
  let done = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const p = line.slice(5).trim();
    if (p === '[DONE]') {
      done = true;
      continue;
    }
    const d = JSON.parse(p).choices?.[0]?.delta || {};
    if (d.content) content += d.content;
    if (d.reasoning_content) reasoning += d.reasoning_content;
    assert.equal(d.reasoning, undefined, 'field reasoning mentah gak boleh lolos');
  }
  return { content, reasoning, done };
}
const delta = (o) => 'data: ' + JSON.stringify({ id: 's1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: o }] }) + '\n\n';

test('SSE: tag <think> kepecah antar delta + reasoning native -> content BERSIH (thinking OFF)', async () => {
  const lines = [
    delta({ role: 'assistant', content: '' }),
    delta({ reasoning: 'mikir native ' }),
    delta({ content: '<' }), delta({ content: 'think' }), delta({ content: '>' }),
    delta({ content: 'rahasia ' }), delta({ content: 'banget' }),
    delta({ content: '</' }), delta({ content: 'think' }), delta({ content: '>' }),
    delta({ content: 'Halo ' }), delta({ content: 'dunia' }),
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n',
    'data: [DONE]\n\n',
  ];
  const out = parseSse(await streamThroughRelay(lines, { keepThinking: false }));
  assert.equal(out.content, 'Halo dunia');
  assert.equal(out.reasoning, '');
  assert.ok(out.done);
});

test('SSE: thinking ON -> thinking lewat field reasoning_content (native + tag), content tetap bersih', async () => {
  const lines = [
    delta({ reasoning: 'native-1 ' }),
    delta({ content: '<think>' }), delta({ content: 'tag-1' }), delta({ content: '</think>' }),
    delta({ content: 'Jawaban' }),
    'data: [DONE]\n\n',
  ];
  const out = parseSse(await streamThroughRelay(lines, { keepThinking: true }));
  assert.equal(out.content, 'Jawaban');
  assert.equal(out.reasoning, 'native-1 tag-1');
});

test('SSE: kasus gpt-oss rusak (<think<|message|> tanpa penutup) -> gak ada reasoning bocor', async () => {
  const lines = [
    delta({ content: '<think' }), delta({ content: '<|message|>' }),
    delta({ content: 'User wants a game. Provide code. No extra commentary beyond minimal.' }),
    delta({ content: 'Berikut ' }), delta({ content: 'game-nya.' }),
    'data: [DONE]\n\n',
  ];
  const out = parseSse(await streamThroughRelay(lines, { keepThinking: false }));
  assert.equal(out.content, 'Berikut game-nya.');
});

test('SSE: stream putus tanpa [DONE] tetap di-flush (jawaban gak hilang)', async () => {
  const lines = [delta({ content: 'Halo ' }), delta({ content: 'tiga' }), delta({ content: ' <th' })];
  const out = parseSse(await streamThroughRelay(lines, { keepThinking: false }));
  assert.equal(out.content, 'Halo tiga <th');
});

test('timeout lokal (provider nge-hang) TIDAK di-fallback berlapis: langsung PROVIDER_TIMEOUT', async () => {
  const { gatewayTimeout } = require('../src/utils/errors');
  mockFetch([() => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }]);
  await assert.rejects(chatService.handleChat({ model: 'openai/gpt-oss-120b', messages: userMsg }), (e) => e.code === 'PROVIDER_TIMEOUT' && e.status === gatewayTimeout().status);
  assert.equal(calls.length, 1, 'gak lanjut ke kandidat lain');
});

// ---------- Jalur penuh handleChat -> runChatAndRespond (tanpa express) ----------
const { runChatAndRespond } = require('../src/utils/http-chat-relay');
async function viaRelay(chatArgs) {
  const server = http.createServer((req, res) => {
    res.status = (c) => ((res.statusCode = c), res);
    res.set = (h) => (Object.keys(h).forEach((k) => res.setHeader(k, h[k])), res);
    res.json = (o) => (res.setHeader('Content-Type', 'application/json'), res.end(JSON.stringify(o)), res);
    runChatAndRespond(req, res, (signal) => chatService.handleChat(chatArgs, { signal }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const saved = globalThis.fetch;
  try {
    // fetch ke server lokal harus pakai fetch ASLI; fetch ke provider tetap mock
    const url = `http://127.0.0.1:${server.address().port}/`;
    const resp = await realFetch(url);
    return { status: resp.status, ctype: resp.headers.get('content-type'), text: await resp.text() };
  } finally {
    globalThis.fetch = saved;
    await new Promise((r) => server.close(r));
  }
}
function mockProviderOnly(steps) {
  calls = [];
  script = [...steps];
  globalThis.fetch = async (url, opts) => {
    const u = new URL(typeof url === 'string' ? url : url.url);
    if (u.hostname === '127.0.0.1') return realFetch(url, opts);
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    calls.push({ host: u.hostname, model: body.model, body });
    const next = script.shift();
    if (!next) throw new Error(`fetch tak terduga ke ${u.hostname}`);
    return next;
  };
}

test('relay non-stream: thinking OFF -> JSON bersih tanpa reasoning', async () => {
  mockProviderOnly([okCompletion('<think>rahasia</think>jawaban', { reasoning: 'rahasia native' })]);
  const r = await viaRelay({ model: 'openai/gpt-oss-120b', messages: userMsg, stream: false });
  assert.equal(r.status, 200);
  const m = JSON.parse(r.text).choices[0].message;
  assert.equal(m.content, 'jawaban');
  assert.equal(m.reasoning, undefined);
  assert.equal(m.reasoning_content, undefined);
});

test('relay non-stream: thinking ON (show_thinking) -> reasoning_content terpisah', async () => {
  mockProviderOnly([okCompletion('<think>tag-mikir</think>jawaban', { reasoning: 'native-mikir' })]);
  const r = await viaRelay({ model: 'openai/gpt-oss-120b', messages: userMsg, stream: false, show_thinking: true, reasoning_effort: 'medium' });
  const m = JSON.parse(r.text).choices[0].message;
  assert.equal(m.content, 'jawaban');
  assert.equal(m.reasoning_content, 'native-mikir\n\ntag-mikir');
});

test('relay stream penuh dari handleChat: tag kepecah + fallback ke saudara Groq setelah 413', async () => {
  const lines = [
    delta({ role: 'assistant', content: '' }),
    delta({ content: '<th' }), delta({ content: 'ink>' }), delta({ content: 'mikir rahasia' }), delta({ content: '</think>' }),
    delta({ content: 'Halo ' }), delta({ content: 'dari saudara' }),
    'data: [DONE]\n\n',
  ];
  mockProviderOnly([jsonRes(413, { error: { message: 'Request too large for model on tokens per minute (TPM)' } }), sseRes(lines)]);
  const r = await viaRelay({ model: 'llama-3.3-70b-versatile', messages: userMsg, stream: true });
  assert.equal(r.status, 200);
  assert.match(r.ctype, /text\/event-stream/);
  const out = parseSse(r.text);
  assert.equal(out.content, 'Halo dari saudara');
  assert.equal(out.reasoning, '');
  assert.ok(out.done);
  assert.deepEqual(calls.map((c) => c.model), ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
});

test('relay: semua kandidat gagal -> JSON error PROVIDER UTAMA, status asli (bukan 502 openrouter)', async () => {
  mockProviderOnly([
    jsonRes(429, { error: { message: 'Rate limit reached' } }, { 'retry-after': '12' }),
    jsonRes(429, { error: { message: 'Rate limit reached' } }),
    jsonRes(402, { error: { message: 'Insufficient credits' } }),
    jsonRes(402, { error: { message: 'Insufficient credits' } }),
  ]);
  const r = await viaRelay({ model: 'openai/gpt-oss-120b', messages: userMsg, stream: false });
  assert.equal(r.status, 429);
  const e = JSON.parse(r.text).error;
  assert.equal(e.code, 'PROVIDER_RATE_LIMITED');
  assert.match(e.message, /groq/i);
  assert.match(e.message, /~12 detik/);
  assert.ok(!/^Provider openrouter/.test(e.message));
});
