'use strict';
const env = require('../src/config/env');
const { searchDuckDuckGo, parseDdgHtml, parseDdgLite } = require('../src/services/web-search.service');
const webContext = require('../src/services/web-context.service');

const args = process.argv.slice(2);
const raw = args.includes('--raw');
const query = args.filter((a) => !a.startsWith('--')).join(' ').trim() || 'siapa presiden indonesia sekarang';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ms = (t0) => `${Date.now() - t0}ms`;

async function rawProbe() {
  console.log('\n=== DIAGNOSA MENTAH ===');
  for (const [name, url, parse, params] of [
    ['html', 'https://html.duckduckgo.com/html/', parseDdgHtml, { q: query, b: '', kl: env.webSearch.region }],
    ['lite', 'https://lite.duckduckgo.com/lite/', parseDdgLite, { q: query, kl: env.webSearch.region }],
  ]) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Referer: new URL(url).origin + '/', Origin: new URL(url).origin },
        body: new URLSearchParams(params).toString(),
      });
      const text = await res.text();
      console.log(`\n[${name}] HTTP ${res.status} | ${text.length} byte | ${ms(t0)} | hasil ter-parse: ${parse(text).length}`);
      console.log(text.slice(0, 700).replace(/\s+/g, ' '));
    } catch (err) {
      console.log(`\n[${name}] GAGAL: ${err.message}`);
    }
  }
}

(async () => {
  console.log(`Query    : ${query}`);
  console.log(`Wilayah  : ${env.webSearch.region} | baca halaman: ${env.webSearch.readPages} | batas konteks: ${env.webSearch.contextMaxChars} karakter\n`);

  let ok = false;
  try {
    const t0 = Date.now();
    const r = await searchDuckDuckGo({ query, region: env.webSearch.region });
    console.log(`DuckDuckGo (${r.engine}) -> ${r.results.length} hasil dalam ${ms(t0)}${r.relaxed ? ' (filter waktu dilonggarkan)' : ''}`);
    r.results.forEach((x, i) => console.log(`  [${i + 1}] ${x.title}\n      ${x.url}\n      ${x.snippet.slice(0, 120)}`));
    ok = r.results.length > 0;
  } catch (err) {
    console.log(`PENCARIAN GAGAL: [${err.code}] ${err.message}`);
  }

  if (ok) {
    const t0 = Date.now();
    const ctx = await webContext.build({ messages: [{ role: 'user', content: query }], clientKey: 'cli' });
    console.log(`\nAlur chat lengkap (cari + buka halaman + rakit konteks): state=${ctx.state} dalam ${ms(t0)}`);
    console.log(`Halaman terbaca: ${ctx.meta.sources.filter((s) => s.read).length}/${ctx.meta.sources.length}`);
    console.log(`Ukuran blok ke model: ${ctx.block.length} karakter\n`);
    console.log(ctx.block);
  }

  if (raw || !ok) await rawProbe();
  process.exit(ok ? 0 : 1);
})();
