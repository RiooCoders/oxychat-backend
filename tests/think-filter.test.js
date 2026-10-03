'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ThinkingFilter, splitThinking, stripThinkingTags, sanitizeCompletionPayload } = require('../src/utils/sanitize-content');

/** Jalanin filter dengan potongan-potongan tertentu, gabungin hasilnya. */
function runChunks(text, chunks, opts) {
  const f = new ThinkingFilter(opts);
  let content = '';
  let thinking = '';
  for (const c of chunks) {
    const r = f.push(c);
    content += r.content;
    thinking += r.thinking;
  }
  const r = f.flush();
  return { content: content + r.content, thinking: thinking + r.thinking };
}
function splitEvery(text, n) {
  const out = [];
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  return out;
}
function randomSplit(text, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const out = [];
  let i = 0;
  while (i < text.length) {
    const n = 1 + Math.floor(rnd() * 9);
    out.push(text.slice(i, i + n));
    i += n;
  }
  return out;
}

const SAMPLES = {
  plain: 'Halo! Ini jawaban biasa tanpa thinking.\n\nSatu dua tiga.',
  think: '<think>Aku mikir dulu ya.\nLangkah 1...</think>\n\nJawaban final di sini.',
  thinking: '<thinking>hmm</thinking>Jawaban.',
  reasoningAttr: '<reasoning effort="high">x</reasoning>\nOke.',
  gptossBroken: '<think<|message|>User wants a simple 3D game. Provide full code. Use informal Indonesian.<|end|><|start|>assistant<|channel|>final<|message|>Berikut game-nya.',
  harmony: '<|channel|>analysis<|message|>Kita perlu jawab singkat.<|end|><|start|>assistant<|channel|>final<|message|>Jawaban: 42',
  residue: '<think>|message|>reasoning</think>Jawaban',
  stripped: 'analysisWe need to answer briefly.assistantfinalHalo, ini jawabannya.',
  specials: 'Halo<|im_end|> dunia<|eot_id|>',
  strayClose: 'reasoning sisa</think>Jawaban',
  inlineCode: 'Pakai tag `<think>` buat mikir, lalu tulis jawaban biasa. Tetap tampil.',
  fenced: 'Contoh:\n```js\nconst re = /<think>[\\s\\S]*?<\\/think>/g;\n```\nSelesai dan tetap tampil.',
  fencedIndented: 'Contoh:\n  ```html\n  <think>ini cuma contoh</think>\n  ```\nSudah.',
  lt: 'Kalau a < b dan c > d maka <b>tebal</b> tetap aman.',
  nearMiss: 'Tag <thinker> dan <reasonable> bukan tag thinking.',
  twoBlocks: '<think>a</think>Satu<think>b</think> Dua',
};

test('ThinkingFilter: hasil (utuh) sesuai harapan', () => {
  assert.equal(splitThinking(SAMPLES.plain).content, SAMPLES.plain, 'teks biasa gak boleh berubah sama sekali');
  assert.deepEqual(splitThinking(SAMPLES.think), { content: 'Jawaban final di sini.', thinking: 'Aku mikir dulu ya.\nLangkah 1...' });
  assert.equal(splitThinking(SAMPLES.thinking).content, 'Jawaban.');
  assert.equal(splitThinking(SAMPLES.reasoningAttr).content, 'Oke.');
  assert.equal(splitThinking(SAMPLES.gptossBroken).content, 'Berikut game-nya.');
  assert.ok(splitThinking(SAMPLES.gptossBroken).thinking.startsWith('User wants a simple 3D game'));
  assert.equal(splitThinking(SAMPLES.harmony).content, 'Jawaban: 42');
  assert.equal(splitThinking(SAMPLES.residue).content, 'Jawaban');
  assert.equal(splitThinking(SAMPLES.stripped).content, 'Halo, ini jawabannya.');
  assert.equal(splitThinking(SAMPLES.specials).content, 'Halo dunia');
  assert.equal(splitThinking(SAMPLES.strayClose).content, 'reasoning sisaJawaban');
  assert.equal(splitThinking(SAMPLES.nearMiss).content, SAMPLES.nearMiss);
  assert.equal(splitThinking(SAMPLES.lt).content, SAMPLES.lt);
  assert.equal(splitThinking(SAMPLES.twoBlocks).content, 'Satu Dua');
});

test('ThinkingFilter: tag di dalam blok kode / inline code TIDAK dianggap thinking', () => {
  assert.equal(splitThinking(SAMPLES.inlineCode).content, SAMPLES.inlineCode);
  assert.equal(splitThinking(SAMPLES.fenced).content, SAMPLES.fenced);
  assert.equal(splitThinking(SAMPLES.fencedIndented).content, SAMPLES.fencedIndented);
});

test('ThinkingFilter: hasil IDENTIK walau stream dipotong di mana pun (1,2,3,5,7 char + acak)', () => {
  for (const [name, text] of Object.entries(SAMPLES)) {
    const whole = runChunks(text, [text], { keepThinking: true });
    for (const n of [1, 2, 3, 4, 5, 7, 11]) {
      assert.deepEqual(runChunks(text, splitEvery(text, n), { keepThinking: true }), whole, `${name} dipotong per ${n} char`);
    }
    for (let seed = 1; seed <= 25; seed++) {
      assert.deepEqual(runChunks(text, randomSplit(text, seed), { keepThinking: true }), whole, `${name} potongan acak seed ${seed}`);
    }
    const wholeHidden = runChunks(text, [text], { keepThinking: false });
    assert.equal(wholeHidden.thinking, '', 'keepThinking=false -> thinking gak pernah keluar');
    assert.equal(wholeHidden.content, whole.content, `${name}: content sama apapun setting keepThinking`);
  }
});

test('ThinkingFilter: thinking TIDAK bocor ke content saat stream (kasus bug lama: tag kepecah antar delta)', () => {
  const f = new ThinkingFilter({ keepThinking: false });
  const deltas = ['<', 'think', '>', 'Aku ', 'lagi ', 'mikir', '</', 'think', '>', 'Jawaban ', 'final'];
  let content = '';
  for (const d of deltas) content += f.push(d).content;
  content += f.flush().content;
  assert.equal(content, 'Jawaban final');
});

test('ThinkingFilter: kasus screenshot (<think<|message|> tanpa penutup, reasoning nyambung ke jawaban)', () => {
  const raw = '<think<|message|>User wants a simple 3D game. Provide full code in one file, using Three.js CDN. Use informal Indonesian. Mention user name. No extra commentary beyond minimal.Berikut contoh game 3D sederhana yang bisa langsung lo copy-paste.';
  const r = runChunks(raw, splitEvery(raw, 3), { keepThinking: false });
  assert.equal(r.content, 'Berikut contoh game 3D sederhana yang bisa langsung lo copy-paste.');
  assert.ok(!r.content.includes('User wants'));
});

test('ThinkingFilter: think gak ditutup + gak ada batas jelas -> tampilkan semuanya (bukan balasan kosong)', () => {
  const r = splitThinking('<think>cuma mikir panjang tanpa jawaban', { keepThinking: false });
  assert.equal(r.content, 'cuma mikir panjang tanpa jawaban');
});

test('ThinkingFilter: teks "analysis" biasa gak salah dikira thinking', () => {
  assert.equal(splitThinking('analysis of data is fun').content, 'analysis of data is fun');
  assert.equal(splitThinking('Analysis: hasilnya bagus').content, 'Analysis: hasilnya bagus');
  const f = new ThinkingFilter();
  let c = '';
  for (const d of ['ana', 'ly', 'sis ', 'ok']) c += f.push(d).content;
  c += f.flush().content;
  assert.equal(c, 'analysis ok');
});

test('sanitizeCompletionPayload: non-stream bersihin content & atur reasoning_content sesuai keepThinking', () => {
  const data = { choices: [{ message: { role: 'assistant', content: '<think>mikir</think>Halo', reasoning: 'native' } }] };
  const hidden = sanitizeCompletionPayload(data);
  assert.equal(hidden.choices[0].message.content, 'Halo');
  assert.equal(hidden.choices[0].message.reasoning_content, undefined);
  assert.equal(hidden.choices[0].message.reasoning, undefined);
  const kept = sanitizeCompletionPayload(data, { keepThinking: true });
  assert.equal(kept.choices[0].message.content, 'Halo');
  assert.equal(kept.choices[0].message.reasoning_content, 'native\n\nmikir');
});

test('stripThinkingTags: nilai kosong/non-string dibalikin apa adanya', () => {
  assert.equal(stripThinkingTags(''), '');
  assert.equal(stripThinkingTags(null), null);
  assert.equal(stripThinkingTags('<think>x</think>ok'), 'ok');
});
