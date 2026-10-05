'use strict';
/**
 * Test integrasi "grounding" (aturan jujur + pencarian web real-time) lewat chat.service dan relay SSE.
 * TANPA express & TANPA internet: fetch di-mock (DuckDuckGo + provider AI), relay dijalankan di http server mini.
 * Jalankan: node --test tests/grounding.test.js
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
  UPSTREAM_TIMEOUT_MS: '2000',
  WEB_SEARCH_READ_PAGES: '0', // test ini fokus ke alur chat; pembacaan halaman diuji di web-context.test.js
  WEB_SEARCH_MAX_PER_CLIENT_PER_MIN: '1000',
  WEB_SEARCH_MAX_PER_MIN: '10000',
  WEB_SEARCH_SHARE_WINDOW_MS: '0', // tiap test harus independen: pertanyaan yang sama dipakai di banyak test
});

const ws = require('../src/services/web-search.service');
const chatService = require('../src/services/chat.service');
const { runChatAndRespond } = require('../src/utils/http-chat-relay');

const realFetch = globalThis.fetch;
let providerCalls = [];
let ddgCalls = [];
let providerScript = [];
let ddgHandler;

const DDG_PAGE = `<div class="results">
<div class="result"><h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fkabar.example%2Fpolitik%2Fpelantikan&amp;rut=1">Presiden Terpilih Dilantik</a></h2>
<a class="result__snippet" href="#">Pelantikan presiden berlangsung khidmat di Jakarta.</a></div>
<div class="result"><h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwiki.example%2Fpresiden&amp;rut=2">Profil Presiden</a></h2>
<a class="result__snippet" href="#">Profil lengkap presiden dan riwayat jabatannya.</a></div></div>`;
const ANOMALY = '<html><body><div class="anomaly-modal__modal">bots use DuckDuckGo too</div></body></html>';

const htmlRes = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
const jsonRes = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const okCompletion = (content) =>
  jsonRes(200, { id: 'c1', object: 'chat.completion', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
function sseRes(lines) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(enc.encode(l)); c.close(); } }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
const delta = (o) => 'data: ' + JSON.stringify({ id: 's1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: o }] }) + '\n\n';

test.beforeEach(() => {
  ws.resetState();
  providerCalls = [];
  ddgCalls = [];
  providerScript = [];
  ddgHandler = () => htmlRes(DDG_PAGE);
  globalThis.fetch = async (url, opts) => {
    const u = new URL(typeof url === 'string' ? url : url.url);
    if (u.hostname === '127.0.0.1') return realFetch(url, opts); // server relay lokal
    if (u.hostname.endsWith('duckduckgo.com')) {
      const form = new URLSearchParams(String((opts && opts.body) || ''));
      ddgCalls.push({ host: u.hostname, q: form.get('q'), df: form.get('df') });
      return ddgHandler(u.hostname);
    }
    const body = JSON.parse(opts.body);
    providerCalls.push({ host: u.hostname, model: body.model, body });
    const next = providerScript.shift();
    if (!next) throw new Error(`fetch tak terduga ke ${u.hostname} (${body.model})`);
    return typeof next === 'function' ? next(body) : next;
  };
});
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

const GPT = 'openai/gpt-oss-120b';
const sysOf = (call) => call.body.messages[0].content;
const lastUserOf = (call) => [...call.body.messages].reverse().find((m) => m.role === 'user').content;

// ---------------------------------------------------------------- aturan inti

test('basa-basi: aturan inti ditempel sebagai system message pertama, TANPA pencarian, pesan user utuh', async () => {
  providerScript = [okCompletion('hai juga')];
  const body = { model: GPT, messages: [{ role: 'user', content: 'halo' }], stream: false };
  const original = JSON.parse(JSON.stringify(body));
  const r = await chatService.handleChat(body);
  assert.equal(r.data.choices[0].message.content, 'hai juga');
  assert.equal(ddgCalls.length, 0);
  const msgs = providerCalls[0].body.messages;
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /ATURAN INTI: JUJUR & AKURAT/);
  assert.match(msgs[0].content, /Sekarang: \w+, \d+ \w+ \d{4}, pukul \d{2}\.\d{2}/);
  assert.doesNotMatch(msgs[0].content, /PENCARIAN WEB/);
  assert.deepEqual(msgs[1], { role: 'user', content: 'halo' });
  assert.deepEqual(body, original, 'body dari pemanggil tidak boleh dimutasi');
  assert.equal(r.data.vaeltrix, undefined, 'tanpa pencarian, tidak ada info sumber');
});

test('persona frontend digabung ke SATU system message, aturan inti di depan (menang atas persona)', async () => {
  providerScript = [okCompletion('ok')];
  await chatService.handleChat({
    model: GPT,
    messages: [{ role: 'system', content: 'Kamu adalah VaeltrixAI gaul' }, { role: 'user', content: 'halo' }],
  });
  const msgs = providerCalls[0].body.messages;
  assert.equal(msgs.length, 2, 'tetap satu system + satu user');
  assert.ok(msgs[0].content.startsWith('=== ATURAN INTI'));
  assert.ok(msgs[0].content.endsWith('Kamu adalah VaeltrixAI gaul'));
});

test('zona waktu client dihormati kalau valid (WITA), kalau ngawur jatuh ke default (WIB)', async () => {
  providerScript = [okCompletion('a'), okCompletion('b')];
  const base = { model: GPT, messages: [{ role: 'user', content: 'halo' }] };
  await chatService.handleChat({ ...base, client_timezone: 'Asia/Makassar' });
  await chatService.handleChat({ ...base, client_timezone: 'zona/ngawur$$' });
  assert.match(sysOf(providerCalls[0]), /pukul \d{2}\.\d{2} WITA/);
  assert.match(sysOf(providerCalls[1]), /pukul \d{2}\.\d{2} WIB/);
});

// ---------------------------------------------------------------- pencarian berhasil

test('pertanyaan fakta: DuckDuckGo dipanggil, hasil ditempel ke pesan user terakhir, suhu dibatasi, field internal TIDAK bocor ke provider', async () => {
  providerScript = [okCompletion('Menurut [1] ...')];
  const r = await chatService.handleChat({
    model: GPT,
    stream: false,
    temperature: 1.0,
    web_search: true,
    client_timezone: 'Asia/Makassar',
    messages: [{ role: 'system', content: 'persona' }, { role: 'user', content: 'siapa presiden indonesia sekarang?' }],
  });
  assert.equal(ddgCalls.length, 1);
  assert.equal(ddgCalls[0].host, 'html.duckduckgo.com');
  assert.equal(ddgCalls[0].q, 'siapa presiden indonesia sekarang');

  const call = providerCalls[0];
  const user = lastUserOf(call);
  assert.ok(user.startsWith('siapa presiden indonesia sekarang?'), 'teks asli user tetap di depan');
  assert.match(user, /\[HASIL PENCARIAN WEB\]/);
  assert.match(user, /\[1\] Presiden Terpilih Dilantik/);
  assert.match(user, /URL: https:\/\/kabar\.example\/politik\/pelantikan/);
  assert.match(user, /\[AKHIR HASIL PENCARIAN WEB\]/);
  assert.match(sysOf(call), /PENCARIAN WEB \(aktif untuk pesan ini, diambil .+ WITA\)/);
  assert.match(sysOf(call), /Tandai klaim dengan nomor sumber/);
  assert.equal(call.body.temperature, 0.7, 'suhu 1.0 harus dibatasi saat memakai hasil pencarian');
  for (const k of ['web_search', 'client_timezone', 'utility', 'vaeltrix']) assert.equal(k in call.body, false, `${k} bocor ke provider`);

  const web = r.data.vaeltrix.web;
  assert.equal(web.state, 'used');
  assert.equal(web.mode, 'search');
  assert.deepEqual(web.sources.map((s) => s.url), ['https://kabar.example/politik/pelantikan', 'https://wiki.example/presiden']);
});

test('suhu: dibatasi hanya kalau memakai hasil pencarian; suhu lebih rendah dihormati; tanpa suhu + cari = batas', async () => {
  providerScript = [okCompletion('a'), okCompletion('b'), okCompletion('c'), okCompletion('d')];
  const q = [{ role: 'user', content: 'siapa presiden indonesia sekarang?' }];
  await chatService.handleChat({ model: GPT, messages: q, temperature: 0.3 });
  await chatService.handleChat({ model: GPT, messages: q });
  await chatService.handleChat({ model: GPT, messages: [{ role: 'user', content: 'halo' }], temperature: 1.0 });
  await chatService.handleChat({ model: GPT, messages: q, temperature: 1.0, web_search: false });
  assert.deepEqual(providerCalls.map((c) => c.body.temperature), [0.3, 0.7, 1.0, 1.0]);
});

test('web_search:false (toggle user dimatikan): tanpa pencarian, aturan inti tetap ada', async () => {
  providerScript = [okCompletion('ok')];
  await chatService.handleChat({ model: GPT, web_search: false, messages: [{ role: 'user', content: 'siapa presiden indonesia sekarang?' }] });
  assert.equal(ddgCalls.length, 0);
  assert.match(sysOf(providerCalls[0]), /ATURAN INTI/);
  assert.doesNotMatch(sysOf(providerCalls[0]), /PENCARIAN WEB/);
  assert.equal(lastUserOf(providerCalls[0]), 'siapa presiden indonesia sekarang?');
});

test('follow-up pendek: query pencarian digabung konteks pertanyaan sebelumnya + filter waktu', async () => {
  providerScript = [okCompletion('ok')];
  await chatService.handleChat({
    model: GPT,
    messages: [
      { role: 'user', content: 'harga iphone 17 terbaru' },
      { role: 'assistant', content: 'Harganya mulai dari ...' },
      { role: 'user', content: 'kalau yang pro?' },
    ],
  });
  assert.equal(ddgCalls[0].q, 'harga iphone 17 terbaru kalau yang pro');
  assert.equal(ddgCalls[0].df, 'm');
});

test('pesan multimodal (array): hasil pencarian ditambahkan sebagai part teks baru; ada gambar = tidak mencari', async () => {
  providerScript = [okCompletion('a'), okCompletion('b')];
  await chatService.handleChat({ model: GPT, messages: [{ role: 'user', content: [{ type: 'text', text: 'siapa presiden indonesia sekarang?' }] }] });
  const parts = lastUserOf(providerCalls[0]);
  assert.equal(parts.length, 2);
  assert.match(parts[1].text, /\[HASIL PENCARIAN WEB\]/);

  ddgCalls = [];
  await chatService.handleChat({
    model: 'qwen/qwen3.6-27b',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'siapa orang ini?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
  });
  assert.equal(ddgCalls.length, 0, 'pertanyaan tentang gambar bukan untuk dicari di web');
});

// ---------------------------------------------------------------- pencarian gagal HARUS jujur

test('DuckDuckGo memblokir: request TETAP sukses, model diberi catatan PENCARIAN WEB GAGAL, pesan user tidak dikotori', async () => {
  ddgHandler = () => htmlRes(ANOMALY, 202);
  providerScript = [okCompletion('Maaf, aku gak bisa verifikasi sekarang.')];
  const r = await chatService.handleChat({ model: GPT, messages: [{ role: 'user', content: 'siapa presiden indonesia sekarang?' }] });
  assert.equal(r.data.choices[0].message.content, 'Maaf, aku gak bisa verifikasi sekarang.');
  const call = providerCalls[0];
  assert.equal(lastUserOf(call), 'siapa presiden indonesia sekarang?', 'gak ada data palsu yang ditempel');
  assert.match(sysOf(call), /CATATAN SISTEM: PENCARIAN WEB GAGAL/);
  assert.match(sysOf(call), /membatasi akses/);
  assert.match(sysOf(call), /Jangan mengaku sudah mencari/);
  assert.equal(r.data.vaeltrix.web.state, 'failed');
  assert.deepEqual(r.data.vaeltrix.web.sources, []);

  // selama cooldown, request berikutnya gak menyentuh DuckDuckGo lagi tapi tetap jujur
  const before = ddgCalls.length;
  providerScript = [okCompletion('ok lagi')];
  await chatService.handleChat({ model: GPT, messages: [{ role: 'user', content: 'berita terbaru hari ini' }] });
  assert.equal(ddgCalls.length, before);
  assert.match(sysOf(providerCalls[1]), /PENCARIAN WEB GAGAL/);
});

test('error tak terduga di dalam pencarian tidak pernah menggagalkan chat', async () => {
  globalThis.fetch = async (url, opts) => {
    const u = new URL(typeof url === 'string' ? url : url.url);
    if (u.hostname.endsWith('duckduckgo.com')) throw new Error('jaringan putus total');
    const body = JSON.parse(opts.body);
    providerCalls.push({ host: u.hostname, model: body.model, body });
    return okCompletion('tetap jawab');
  };
  const r = await chatService.handleChat({ model: GPT, messages: [{ role: 'user', content: 'siapa presiden indonesia sekarang?' }] });
  assert.equal(r.data.choices[0].message.content, 'tetap jawab');
  assert.match(sysOf(providerCalls[0]), /PENCARIAN WEB GAGAL/);
});

// ---------------------------------------------------------------- permukaan API publik, utilitas, provider bawaan

test('API publik (/v1): tanpa web_search TIDAK mencari; dengan web_search:true mencari dan memakai sitasi nama situs', async () => {
  providerScript = [okCompletion('a'), okCompletion('b')];
  const msgs = [{ role: 'user', content: 'siapa presiden indonesia sekarang?' }];
  await chatService.handleChat({ model: GPT, messages: msgs }, { surface: 'api' });
  assert.equal(ddgCalls.length, 0);
  assert.match(sysOf(providerCalls[0]), /ATURAN INTI/);

  await chatService.handleChat({ model: GPT, messages: msgs, web_search: true }, { surface: 'api', clientKey: 'key:1' });
  assert.equal(ddgCalls.length, 1);
  assert.match(sysOf(providerCalls[1]), /nama situsnya/);
  assert.doesNotMatch(sysOf(providerCalls[1]), /nomor sumber/);
});

test('utility:true (panggilan internal frontend) dihormati HANYA di permukaan app; di API publik diabaikan', async () => {
  providerScript = [okCompletion('judul'), okCompletion('x')];
  const msgs = [{ role: 'user', content: 'siapa presiden indonesia sekarang?' }];
  await chatService.handleChat({ model: GPT, messages: msgs, utility: true });
  assert.equal(ddgCalls.length, 0);
  assert.deepEqual(providerCalls[0].body.messages, msgs, 'utilitas: pesan persis seperti aslinya, tanpa aturan');

  await chatService.handleChat({ model: GPT, messages: msgs, utility: true, web_search: false }, { surface: 'api' });
  assert.match(sysOf(providerCalls[1]), /ATURAN INTI/, 'API publik gak bisa melewati aturan inti dengan flag utility');
});

test('bug tak terduga di grounding TIDAK menggagalkan chat (fitur tambahan, bukan titik gagal tunggal)', async () => {
  const webContext = require('../src/services/web-context.service');
  const realDecide = webContext.decide;
  webContext.decide = () => {
    throw new Error('bug simulasi di decide()');
  };
  try {
    providerScript = [okCompletion('tetap dijawab')];
    const msgs = [{ role: 'user', content: 'siapa presiden indonesia sekarang?' }];
    const r = await chatService.handleChat({ model: GPT, messages: msgs });
    assert.equal(r.data.choices[0].message.content, 'tetap dijawab');
    assert.deepEqual(providerCalls[0].body.messages, msgs, 'tanpa grounding: pesan diteruskan apa adanya');
  } finally {
    webContext.decide = realDecide;
  }
});

test('abort dari client saat pencarian berjalan tidak ditelan jadi "grounding gagal"', async () => {
  ddgHandler = () => new Promise((resolve) => setTimeout(() => resolve(htmlRes(DDG_PAGE)), 300));
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  providerScript = [okCompletion('seharusnya tidak sampai ke provider')];
  await assert.rejects(
    chatService.handleChat({ model: GPT, messages: [{ role: 'user', content: 'siapa presiden indonesia sekarang?' }] }, { signal: ac.signal }),
    (e) => e.name === 'AbortError'
  );
  assert.equal(providerCalls.length, 0, 'provider tidak boleh dipanggil kalau client sudah pergi');
});

test('model Perplexity (pencarian bawaan): DuckDuckGo gak dipakai, aturan inti tetap ada', async () => {
  providerScript = [okCompletion('ok')];
  await chatService.handleChat({ model: 'sonar', messages: [{ role: 'user', content: 'siapa presiden indonesia sekarang?' }] });
  assert.equal(ddgCalls.length, 0);
  assert.match(providerCalls[0].host, /perplexity/);
  assert.match(sysOf(providerCalls[0]), /ATURAN INTI/);
});

test('injectSystem & attachToLastUser: tidak memutasi input, menangani system berformat array & tanpa pesan user', () => {
  const { injectSystem, attachToLastUser } = chatService;
  const arr = [{ role: 'system', content: [{ type: 'text', text: 'persona' }] }, { role: 'user', content: 'x' }];
  const snapshot = JSON.parse(JSON.stringify(arr));
  const out = injectSystem(arr, 'ATURAN');
  assert.deepEqual(arr, snapshot);
  assert.deepEqual(out[0].content, [{ type: 'text', text: 'ATURAN' }, { type: 'text', text: 'persona' }]);
  assert.deepEqual(injectSystem([{ role: 'user', content: 'x' }], 'A')[0], { role: 'system', content: 'A' });
  assert.deepEqual(injectSystem(arr, ''), arr);
  const only = [{ role: 'assistant', content: 'hai' }];
  assert.deepEqual(attachToLastUser(only, 'BLOK'), only);
  assert.equal(attachToLastUser([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }], 'BLOK')[2].content, 'c\n\nBLOK');
});

// ---------------------------------------------------------------- relay SSE

async function viaRelay(chatBody, { enableEvents = true, surface = 'app' } = {}) {
  const server = http.createServer((req, res) => {
    res.status = (c) => ((res.statusCode = c), res);
    res.set = (h) => (Object.keys(h).forEach((k) => res.setHeader(k, h[k])), res);
    res.json = (o) => (res.setHeader('Content-Type', 'application/json'), res.end(JSON.stringify(o)), res);
    req.body = chatBody;
    runChatAndRespond(req, res, (signal, events) => chatService.handleChat(chatBody, { signal, events, surface, clientKey: 'test' }), { enableEvents });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const resp = await realFetch(`http://127.0.0.1:${server.address().port}/`);
    return { status: resp.status, ctype: resp.headers.get('content-type'), text: await resp.text() };
  } finally {
    await new Promise((r) => server.close(r));
  }
}
function sseEvents(text) {
  return text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .map((p) => (p === '[DONE]' ? '[DONE]' : JSON.parse(p)));
}

test('relay stream + pencarian: urutan chunk = status searching -> sumber -> jawaban model -> [DONE]', async () => {
  providerScript = [sseRes([delta({ role: 'assistant', content: '' }), delta({ content: 'Halo ' }), delta({ content: 'dunia' }), 'data: [DONE]\n\n'])];
  const r = await viaRelay({ model: GPT, stream: true, messages: [{ role: 'user', content: 'siapa presiden indonesia sekarang?' }] });
  assert.equal(r.status, 200);
  assert.match(r.ctype, /text\/event-stream/);
  const ev = sseEvents(r.text);
  assert.equal(ev[0].vaeltrix.status, 'searching');
  assert.equal(ev[1].vaeltrix.web.state, 'used');
  assert.equal(ev[1].vaeltrix.web.sources.length, 2);
  const content = ev.filter((e) => e !== '[DONE]' && e.choices).map((e) => e.choices[0].delta.content || '').join('');
  assert.equal(content, 'Halo dunia');
  assert.equal(ev[ev.length - 1], '[DONE]');
});

test('relay stream TANPA pencarian: persis seperti dulu, tak ada chunk vaeltrix', async () => {
  providerScript = [sseRes([delta({ content: 'Hai' }), 'data: [DONE]\n\n'])];
  const r = await viaRelay({ model: GPT, stream: true, messages: [{ role: 'user', content: 'halo' }] });
  const ev = sseEvents(r.text).filter((e) => e !== '[DONE]');
  assert.ok(ev.length > 0 && ev.every((e) => Array.isArray(e.choices) && !e.vaeltrix));
});

test('relay stream: provider gagal SETELAH pencarian (SSE sudah dibuka) -> chunk error + [DONE], bukan koneksi menggantung', async () => {
  providerScript = [jsonRes(400, { error: { message: 'messages: invalid shape' } })];
  const r = await viaRelay({ model: GPT, stream: true, messages: [{ role: 'user', content: 'siapa presiden indonesia sekarang?' }] });
  assert.equal(r.status, 200, 'header SSE sudah terkirim, status HTTP gak bisa diubah');
  const ev = sseEvents(r.text);
  const err = ev.find((e) => e !== '[DONE]' && e.error);
  assert.ok(err, 'harus ada chunk error');
  assert.equal(err.error.code, 'PROVIDER_INVALID_REQUEST');
  assert.equal(ev[ev.length - 1], '[DONE]');
});

test('relay stream: error TANPA pencarian tetap HTTP error biasa (perilaku lama tidak berubah)', async () => {
  providerScript = [jsonRes(400, { error: { message: 'messages: invalid shape' } })];
  const r = await viaRelay({ model: GPT, stream: true, messages: [{ role: 'user', content: 'halo' }] });
  assert.equal(r.status, 400);
  assert.equal(JSON.parse(r.text).error.code, 'PROVIDER_INVALID_REQUEST');
});

test('relay API publik (enableEvents=false): stream tetap murni OpenAI-compatible walau pencarian jalan', async () => {
  providerScript = [sseRes([delta({ content: 'Hai' }), 'data: [DONE]\n\n'])];
  const r = await viaRelay(
    { model: GPT, stream: true, web_search: true, messages: [{ role: 'user', content: 'siapa presiden indonesia sekarang?' }] },
    { enableEvents: false, surface: 'api' }
  );
  assert.equal(ddgCalls.length, 1, 'pencarian tetap jalan');
  const ev = sseEvents(r.text).filter((e) => e !== '[DONE]');
  assert.ok(ev.every((e) => Array.isArray(e.choices) && !e.vaeltrix), 'klien pihak ketiga gak boleh ketemu chunk tanpa `choices`');
});

test('relay non-stream: JSON berisi vaeltrix.web (state + sumber) dan konten bersih', async () => {
  providerScript = [okCompletion('Jawaban [1]')];
  const r = await viaRelay({ model: GPT, stream: false, messages: [{ role: 'user', content: 'siapa presiden indonesia sekarang?' }] });
  assert.equal(r.status, 200);
  const data = JSON.parse(r.text);
  assert.equal(data.choices[0].message.content, 'Jawaban [1]');
  assert.equal(data.vaeltrix.web.state, 'used');
  assert.equal(data.vaeltrix.web.sources[0].domain, 'kabar.example');
});
