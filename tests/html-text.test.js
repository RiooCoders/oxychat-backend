'use strict';
/**
 * Test utils/html-text.js: HTML dari internet = input yang gak dipercaya, jadi selain hasil yang benar
 * kita juga cek KETAHANAN (gak hang / gak meledak di HTML sengaja dibuat jahat).
 * Jalankan: node --test tests/html-text.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { htmlToText, extractMeta, decodeEntities, cleanSnippet, cutAt, normalizeDate } = require('../src/utils/html-text');

const NOW = Date.parse('2026-10-04T12:00:00Z');

test('htmlToText: buang script/style/nav/footer, pertahankan isi, heading diberi prefix', () => {
  const html = `<html><head><title>T</title><style>.a{color:red}</style></head><body>
    <nav><a href="/">Beranda</a><a href="/x">Menu panjang yang tidak penting sama sekali di sini ya</a></nav>
    <script>var rahasia = "jangan muncul";</script>
    <main><h1>Judul Utama Artikel</h1>
    <p>Paragraf pertama berisi kalimat yang cukup panjang supaya lolos filter baris pendek di parser.</p>
    <p>Paragraf kedua juga cukup panjang &amp; memuat entitas &quot;kutip&quot; serta angka 1.234.</p>
    </main><footer>Hak cipta footer yang panjang sekali dan tidak boleh ikut terbaca oleh model.</footer></body></html>`;
  const text = htmlToText(html);
  assert.match(text, /## Judul Utama Artikel/);
  assert.match(text, /Paragraf pertama berisi kalimat/);
  assert.match(text, /memuat entitas "kutip" serta angka 1\.234\./);
  assert.doesNotMatch(text, /rahasia|Beranda|Hak cipta|color:red/);
});

test('htmlToText: <form> pembungkus seluruh halaman (gaya ASP.NET) TIDAK ikut dibuang', () => {
  const html = '<body><form id="aspnetForm"><div><p>Konten asli halaman yang cukup panjang supaya terbaca oleh parser dengan benar.</p></div></form></body>';
  assert.match(htmlToText(html), /Konten asli halaman/);
});

test('htmlToText: <header> gak ikut kebuang gara-gara pembuangan <head>', () => {
  const html = '<html><head><title>x</title></head><body><header><p>Teks di dalam header halaman yang cukup panjang untuk dibaca model.</p></header></body></html>';
  assert.match(htmlToText(html), /Teks di dalam header halaman/);
});

test('htmlToText: sel tabel dipisah " | " dan baris duplikat dibuang', () => {
  const html = '<body><table><tr><td>Produk Alpha</td><td>Rp 1.000.000</td></tr><tr><td>Produk Alpha</td><td>Rp 1.000.000</td></tr></table></body>';
  const text = htmlToText(html);
  assert.equal(text.split('\n').filter((l) => l.includes('Produk Alpha')).length, 1);
  assert.match(text, /Produk Alpha \| Rp 1\.000\.000/);
});

test('htmlToText: input jahat (tag gak ditutup, nested dalam, komentar gantung) selesai cepat', () => {
  const evil = [
    '<div'.repeat(300000),
    '<script>'.repeat(50000),
    '<!--'.repeat(100000),
    '<p>a</p>'.repeat(150000),
    '<<<<<<<<<<'.repeat(100000),
    '<a '.repeat(200000),
  ];
  for (const html of evil) {
    const t0 = Date.now();
    htmlToText(html);
    const ms = Date.now() - t0;
    assert.ok(ms < 2500, `terlalu lambat (${ms}ms) untuk input jahat berawalan ${JSON.stringify(html.slice(0, 12))}`);
  }
});

test('htmlToText: input > batas dipotong dulu (gak makan memori tanpa batas)', () => {
  const big = '<p>' + 'kalimat panjang yang berulang-ulang. '.repeat(200000) + '</p>';
  const t0 = Date.now();
  const text = htmlToText(big, { maxInputChars: 100000 });
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(text.length <= 100000);
});

test('extractMeta: judul, deskripsi, tanggal terbit (prioritas published_time > modified_time)', () => {
  const html = `<html><head><title> Judul &amp; Berita </title>
    <meta name="description" content="Deskripsi &quot;singkat&quot;">
    <meta property="article:published_time" content="2026-10-03T08:30:00+07:00">
    <meta property="article:modified_time" content="2026-10-04T01:00:00+07:00">
    </head>`;
  const m = extractMeta(html, { now: NOW });
  assert.equal(m.title, 'Judul & Berita');
  assert.equal(m.description, 'Deskripsi "singkat"');
  assert.equal(m.published, '2026-10-03');
});

test('extractMeta: tanggal masa depan / ngaco diabaikan, jatuh ke sumber tanggal berikutnya', () => {
  const html = `<head><meta property="article:published_time" content="2099-01-01">
    <meta name="date" content="bukan tanggal"><meta property="article:modified_time" content="2026-10-01"></head>`;
  assert.equal(extractMeta(html, { now: NOW }).published, '2026-10-01');
});

test('extractMeta: fallback ke JSON-LD lalu <time datetime>', () => {
  assert.equal(
    extractMeta('<head><script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-09-30T10:00:00Z"}</script></head>', { now: NOW }).published,
    '2026-09-30'
  );
  assert.equal(extractMeta('<body><time datetime="2026-09-29">29 Sep</time></body>', { now: NOW }).published, '2026-09-29');
  assert.equal(extractMeta('<body>tanpa tanggal apa pun</body>', { now: NOW }).published, null);
});

test('extractMeta: input jahat selesai cepat', () => {
  for (const html of ['<time '.repeat(60000), '<meta '.repeat(100000), '<title>' + 'x'.repeat(2000000)]) {
    const t0 = Date.now();
    extractMeta(html, { now: NOW });
    assert.ok(Date.now() - t0 < 2000);
  }
});

test('normalizeDate: tahun < 1990 & masa depan ditolak', () => {
  assert.equal(normalizeDate('1985-01-01', NOW), null);
  assert.equal(normalizeDate('2026-10-20', NOW), null);
  assert.equal(normalizeDate('2026-10-04T05:00:00Z', NOW), '2026-10-04');
  assert.equal(normalizeDate('', NOW), null);
});

test('decodeEntities: numerik valid/invalid, nama dikenal/tidak, tanpa dekode ganda', () => {
  assert.equal(decodeEntities('a&#8217;b &#x1F600; &amp;lt;'), 'a’b 😀 &lt;');
  assert.equal(decodeEntities('x&#0;y&#99999999;z'), 'x y z');
  assert.equal(decodeEntities('&unknownentity; &nbsp;|'), '&unknownentity;  |');
});

test('cleanSnippet: HTML pendek jadi satu baris bersih', () => {
  assert.equal(cleanSnippet('Ini <b>cuplikan</b> &amp; <i>isi</i><br>baris'), 'Ini cuplikan & isi baris');
  assert.equal(cleanSnippet(null), '');
});

test('cutAt: memotong di batas kalimat/baris dan menambah elipsis', () => {
  const t = 'Kalimat satu selesai di sini. Kalimat dua yang lebih panjang lagi dan terus berlanjut tanpa akhir yang jelas';
  const c = cutAt(t, 60);
  assert.ok(c.endsWith('…'));
  assert.ok(c.length <= 61);
  assert.equal(cutAt('pendek', 60), 'pendek');
});
