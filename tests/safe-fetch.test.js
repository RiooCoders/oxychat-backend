'use strict';
/**
 * Test utils/safe-fetch.js (pengaman SSRF untuk pembaca halaman web).
 * Server lokal dipakai buat nyimulasiin web; pengecekan IP default-nya dimatiin HANYA lewat parameter
 * createSafeFetcher() di test ini (gak ada env var yang bisa nyalain/matiin di produksi).
 * Jalankan: node --test tests/safe-fetch.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { createSafeFetcher, safeGet, isPublicIp } = require('../src/utils/safe-fetch');

// ---------------------------------------------------------------- tabel IP

test('isPublicIp: IP privat/loopback/link-local/multicast/dokumentasi/IPv6 terselubung SEMUA ditolak', () => {
  const blocked = [
    '127.0.0.1', '127.1.2.3', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '240.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::127.0.0.1',
    '64:ff9b::7f00:1', '2002:7f00:1::1', '2001:db8::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    'bukan-ip', '', '999.1.1.1',
  ];
  for (const ip of blocked) assert.equal(isPublicIp(ip), false, `harusnya DITOLAK: ${ip}`);
});

test('isPublicIp: IP publik yang sah tetap boleh (termasuk tepat di luar rentang privat)', () => {
  const allowed = [
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '11.0.0.1',
    '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808',
  ];
  for (const ip of allowed) assert.equal(isPublicIp(ip), true, `harusnya BOLEH: ${ip}`);
});

// ---------------------------------------------------------------- instance default (produksi): semua yang berbahaya ditolak

test('safeGet default: target internal/skema aneh/kredensial/port non-standar ditolak SEBELUM koneksi', async () => {
  const cases = [
    ['http://127.0.0.1/', 'BLOCKED_IP'],
    ['http://127.0.0.1:3000/admin', 'BAD_PORT'],
    ['http://[::1]/', 'BLOCKED_IP'],
    ['http://169.254.169.254/latest/meta-data/', 'BLOCKED_IP'],
    ['http://10.0.0.5/', 'BLOCKED_IP'],
    ['http://2130706433/', 'BLOCKED_IP'], // desimal = 127.0.0.1 (URL parser menormalkan)
    ['http://0x7f.1/', 'BLOCKED_IP'], // hex/pendek = 127.0.0.1
    ['http://localhost/', 'BLOCKED_IP'], // hostname -> resolve ke loopback, dicek saat lookup
    ['http://user:pass@example.com/', 'BAD_URL'],
    ['ftp://example.com/file', 'BAD_PROTOCOL'],
    ['file:///etc/passwd', 'BAD_PROTOCOL'],
    ['javascript:alert(1)', 'BAD_PROTOCOL'],
    ['http://example.com:8080/', 'BAD_PORT'],
    ['bukan url', 'BAD_URL'],
  ];
  for (const [url, code] of cases) {
    await assert.rejects(safeGet(url, { timeoutMs: 2000 }), (e) => e.code === code, `${url} -> harusnya ${code}`);
  }
});

// ---------------------------------------------------------------- server web palsu

const BOMB = zlib.gzipSync(Buffer.alloc(30 * 1024 * 1024)); // ~30KB terkompresi, 30MB setelah dekompresi
const HTML = '<html><body><p>halo dunia dari server palsu</p></body></html>';

function startServer() {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    if (path === '/ok') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HTML);
    }
    if (path === '/404') {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      return res.end('nope');
    }
    if (path === '/pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      return res.end('%PDF-1.4');
    }
    if (path === '/gzip') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
      return res.end(zlib.gzipSync(HTML));
    }
    if (path === '/br') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'br' });
      return res.end(zlib.brotliCompressSync(HTML));
    }
    if (path === '/bomb') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
      return res.end(BOMB);
    }
    if (path === '/weird-enc') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'compress' });
      return res.end('xx');
    }
    if (path === '/big') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      const chunk = Buffer.alloc(64 * 1024, 'a');
      let n = 0;
      const pump = () => {
        while (n < 100) {
          n++;
          if (!res.write(chunk)) return res.once('drain', pump);
        }
        res.end();
      };
      return pump();
    }
    if (path === '/r1') {
      res.writeHead(302, { Location: '/ok' });
      return res.end();
    }
    if (path === '/loop') {
      res.writeHead(302, { Location: '/loop' });
      return res.end();
    }
    if (path === '/to-meta') {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      return res.end();
    }
    if (path === '/slow') return; // sengaja gak pernah dibalas
    res.writeHead(500);
    res.end();
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(r);
          }),
      })
    )
  );
}

// fetcher khusus test: hanya loopback yang diizinkan (kebalikan dari produksi), port bebas
const local = createSafeFetcher({ isAllowedIp: (ip) => ip === '127.0.0.1', allowedPorts: null });

test('fetch normal: HTML, gzip, brotli terbaca; status 404 -> ok:false', async () => {
  const s = await startServer();
  try {
    for (const p of ['/ok', '/gzip', '/br']) {
      const r = await local.get(s.base + p, { timeoutMs: 3000 });
      assert.equal(r.ok, true, p);
      assert.equal(r.body.toString('utf8'), HTML, p);
      assert.equal(r.truncated, false, p);
    }
    const nf = await local.get(s.base + '/404', { timeoutMs: 3000 });
    assert.equal(nf.ok, false);
    assert.equal(nf.status, 404);
  } finally {
    await s.close();
  }
});

test('tipe non-teks (PDF) dan encoding aneh dilewati tanpa mengunduh isinya', async () => {
  const s = await startServer();
  try {
    const pdf = await local.get(s.base + '/pdf', { timeoutMs: 3000 });
    assert.equal(pdf.ok, false);
    assert.equal(pdf.skipped, 'UNSUPPORTED_TYPE');
    const enc = await local.get(s.base + '/weird-enc', { timeoutMs: 3000 });
    assert.equal(enc.ok, false);
    assert.equal(enc.skipped, 'UNSUPPORTED_ENCODING');
  } finally {
    await s.close();
  }
});

test('batas ukuran: body 6MB dipotong tepat di maxBytes (truncated:true)', async () => {
  const s = await startServer();
  try {
    const r = await local.get(s.base + '/big', { timeoutMs: 5000, maxBytes: 200000 });
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true);
    assert.equal(r.body.length, 200000);
  } finally {
    await s.close();
  }
});

test('zip-bomb (30MB setelah dekompresi) dipotong di maxBytes, memori aman', async () => {
  const s = await startServer();
  try {
    const before = process.memoryUsage().rss;
    const r = await local.get(s.base + '/bomb', { timeoutMs: 5000, maxBytes: 100000 });
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true);
    assert.equal(r.body.length, 100000);
    assert.ok(process.memoryUsage().rss - before < 80 * 1024 * 1024, 'pemakaian memori melonjak');
  } finally {
    await s.close();
  }
});

test('redirect diikuti; loop redirect ditolak; redirect ke IP metadata cloud DIBLOKIR di hop kedua', async () => {
  const s = await startServer();
  try {
    const ok = await local.get(s.base + '/r1', { timeoutMs: 3000 });
    assert.equal(ok.ok, true);
    assert.ok(ok.finalUrl.endsWith('/ok'));
    await assert.rejects(local.get(s.base + '/loop', { timeoutMs: 3000 }), (e) => e.code === 'TOO_MANY_REDIRECTS');
    await assert.rejects(local.get(s.base + '/to-meta', { timeoutMs: 3000 }), (e) => e.code === 'BLOCKED_IP');
  } finally {
    await s.close();
  }
});

test('DNS: hostname yang resolve ke IP terlarang ditolak saat koneksi (bukan cuma saat parse URL)', async () => {
  const s = await startServer();
  try {
    const port = new URL(s.base).port;
    // loopback dilarang di fetcher ini; "localhost" resolve ke 127.0.0.1 -> harus DITOLAK walau bukan IP literal
    const strict = createSafeFetcher({ isAllowedIp: (ip) => ip !== '127.0.0.1' && ip !== '::1', allowedPorts: null });
    await assert.rejects(strict.get(`http://localhost:${port}/ok`, { timeoutMs: 3000 }), (e) => e.code === 'BLOCKED_IP');
  } finally {
    await s.close();
  }
});

test('timeout total dan abort dari luar menghentikan request yang menggantung', async () => {
  const s = await startServer();
  try {
    let t0 = Date.now();
    await assert.rejects(local.get(s.base + '/slow', { timeoutMs: 400 }), (e) => e.code === 'TIMEOUT');
    assert.ok(Date.now() - t0 < 2000);

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    t0 = Date.now();
    await assert.rejects(local.get(s.base + '/slow', { timeoutMs: 8000, signal: ac.signal }), (e) => e.code === 'ABORTED');
    assert.ok(Date.now() - t0 < 2000);

    // signal yang sudah abort dari awal
    const dead = new AbortController();
    dead.abort();
    await assert.rejects(local.get(s.base + '/ok', { timeoutMs: 3000, signal: dead.signal }), (e) => e.code === 'ABORTED');
  } finally {
    await s.close();
  }
});
