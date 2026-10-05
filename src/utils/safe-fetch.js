'use strict';

/**
 * Fetcher halaman web yang AMAN buat dipakai server.
 *
 * URL yang kita buka berasal dari hasil pencarian / pesan user = input yang gak dipercaya.
 * Tanpa pengaman, orang bisa nyuruh server buka http://169.254.169.254 (metadata cloud),
 * http://localhost:3000/admin, atau IP internal lain (SSRF). Pengamannya:
 *  - hanya http/https, port 80/443, tanpa user:pass di URL
 *  - IP tujuan dicek SAAT KONEKSI (lookup kustom), jadi DNS rebinding & domain yang resolve ke IP privat ketolak
 *  - IP literal (http://127.0.0.1, http://[::1], http://2130706433) dicek manual (Node nge-skip lookup buat IP literal)
 *  - redirect diikuti manual (maks 3) dan SETIAP hop divalidasi ulang
 *  - batas waktu total, batas ukuran body (setelah dekompresi, jadi kebal zip-bomb), hanya tipe teks/HTML
 */

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const zlib = require('node:zlib');

class SafeFetchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SafeFetchError';
    this.code = code;
  }
}

// ------------------------------------------------------------------ cek IP

const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function v4ToInt(ip) {
  const p = ip.split('.').map(Number);
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}

const V4_BLOCKED_INT = V4_BLOCKED.map(([base, bits]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [(v4ToInt(base) & mask) >>> 0, mask];
});

function isBlockedV4(ip) {
  const n = v4ToInt(ip);
  return V4_BLOCKED_INT.some(([netAddr, mask]) => ((n & mask) >>> 0) === netAddr);
}

/** "2001:db8::1" / "::ffff:1.2.3.4" -> array 8 angka 16-bit, atau null kalau gak valid. */
function parseIPv6(input) {
  let ip = String(input).split('%')[0].toLowerCase();
  let tail = null;
  if (ip.includes('.')) {
    const lastColon = ip.lastIndexOf(':');
    const v4 = ip.slice(lastColon + 1);
    if (!net.isIPv4(v4)) return null;
    const p = v4.split('.').map(Number);
    tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
    ip = ip.slice(0, lastColon + 1) + '0:0';
  }
  let groups;
  const dbl = ip.indexOf('::');
  if (dbl !== -1) {
    const head = ip.slice(0, dbl) ? ip.slice(0, dbl).split(':') : [];
    const rest = ip.slice(dbl + 2) ? ip.slice(dbl + 2).split(':') : [];
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill('0'), ...rest];
  } else {
    groups = ip.split(':');
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  if (tail) {
    nums[6] = tail[0];
    nums[7] = tail[1];
  }
  return nums;
}

function embeddedV4(g6, g7) {
  return [(g6 >> 8) & 255, g6 & 255, (g7 >> 8) & 255, g7 & 255].join('.');
}

function isPublicV6(ip) {
  const g = parseIPv6(ip);
  if (!g) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
  // ::ffff:a.b.c.d (IPv4-mapped) dan ::a.b.c.d (IPv4-compatible, termasuk :: dan ::1) -> nilai IPv4-nya yang dicek
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return !isBlockedV4(embeddedV4(g6, g7));
  }
  // 64:ff9b::/96 (NAT64) -> IPv4 yang ditempel di ujung
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return !isBlockedV4(embeddedV4(g6, g7));
  }
  // Allowlist: cuma global unicast 2000::/3 yang boleh. fc00::/7, fe80::/10, ff00::/8, dll otomatis ketolak.
  if ((g0 & 0xe000) !== 0x2000) return false;
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // dokumentasi
  if (g0 === 0x2001 && g1 === 0x0000) return false; // Teredo
  if (g0 === 0x2002) return !isBlockedV4(embeddedV4(g1, g2)); // 6to4 -> IPv4 yang ditempel
  return true;
}

/** true = IP publik yang boleh dituju. IP privat/loopback/link-local/multicast/dll = false. */
function isPublicIp(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return !isBlockedV4(ip);
  if (fam === 6) return isPublicV6(ip);
  return false;
}

// ------------------------------------------------------------------ validasi URL & lookup

function parseAndValidate(urlStr, isAllowedIp, allowedPorts) {
  let u;
  try {
    u = new URL(urlStr);
  } catch (_) {
    throw new SafeFetchError('BAD_URL', 'URL tidak valid');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SafeFetchError('BAD_PROTOCOL', 'Hanya http/https yang diizinkan');
  }
  if (u.username || u.password) throw new SafeFetchError('BAD_URL', 'URL dengan kredensial ditolak');
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (allowedPorts && !allowedPorts.includes(port)) throw new SafeFetchError('BAD_PORT', 'Port selain 80/443 ditolak');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host.length > 253) throw new SafeFetchError('BAD_URL', 'Hostname tidak valid');
  if (net.isIP(host) && !isAllowedIp(host)) {
    throw new SafeFetchError('BLOCKED_IP', 'Alamat internal/privat ditolak');
  }
  return u;
}

function makeGuardedLookup(isAllowedIp) {
  return function guardedLookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
      if (!list.length) return callback(new SafeFetchError('DNS', 'Hostname tidak ditemukan'));
      const bad = list.find((a) => !isAllowedIp(a.address));
      if (bad) return callback(new SafeFetchError('BLOCKED_IP', 'Hostname mengarah ke alamat internal/privat'));
      if (options && options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

// ------------------------------------------------------------------ request

const TEXT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain']);
const EMPTY = Buffer.alloc(0);

function requestOnce(u, { lookup, timeoutMs, maxBytes, signal, headers, acceptTypes }) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    let settled = false;
    let timer = null;
    let req = null;

    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const wrap = (err) =>
      err instanceof SafeFetchError ? err : new SafeFetchError(err.code || 'NETWORK', err.message || 'Gagal terhubung');
    function onAbort() {
      if (req) req.destroy(new SafeFetchError('ABORTED', 'Dibatalkan'));
      else done(reject, new SafeFetchError('ABORTED', 'Dibatalkan'));
    }

    if (timeoutMs <= 0) return reject(new SafeFetchError('TIMEOUT', 'Waktu habis'));

    req = lib.request(
      u,
      {
        method: 'GET',
        lookup,
        agent: false,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; VaeltrixBot/1.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.2',
          'Accept-Language': 'id,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          Connection: 'close',
          ...headers,
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          return done(resolve, { redirect: location, status });
        }
        const contentType = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (status < 200 || status >= 300) {
          res.resume();
          return done(resolve, { ok: false, status, contentType, body: EMPTY });
        }
        if (contentType && !acceptTypes.has(contentType)) {
          res.destroy();
          return done(resolve, { ok: false, status, contentType, skipped: 'UNSUPPORTED_TYPE', body: EMPTY });
        }

        const enc = String(res.headers['content-encoding'] || '').toLowerCase().trim();
        let stream = res;
        if (enc === 'gzip' || enc === 'x-gzip' || enc === 'deflate') stream = res.pipe(zlib.createUnzip());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        else if (enc && enc !== 'identity') {
          res.destroy();
          return done(resolve, { ok: false, status, contentType, skipped: 'UNSUPPORTED_ENCODING', body: EMPTY });
        }

        const chunks = [];
        let total = 0;
        const finishOk = (truncated) =>
          done(resolve, { ok: true, status, contentType, headers: res.headers, body: Buffer.concat(chunks), truncated });
        const failOrPartial = (err) => {
          if (settled) return;
          if (total > 0) {
            stream.destroy();
            return finishOk(true);
          }
          done(reject, wrap(err));
        };

        stream.on('data', (chunk) => {
          if (settled) return;
          if (total + chunk.length > maxBytes) {
            chunks.push(chunk.subarray(0, maxBytes - total));
            total = maxBytes;
            if (stream !== res) res.destroy();
            stream.destroy();
            return finishOk(true);
          }
          chunks.push(chunk);
          total += chunk.length;
        });
        stream.on('end', () => finishOk(false));
        stream.on('error', failOrPartial);
        if (stream !== res) res.on('error', failOrPartial);
      }
    );

    // handler 'error' HARUS terpasang sebelum kemungkinan destroy() di bawah (abort/timeout), kalau enggak
    // event error-nya jadi exception tak tertangani dan promise-nya menggantung.
    req.on('error', (err) => done(reject, wrap(err)));
    timer = setTimeout(() => req.destroy(new SafeFetchError('TIMEOUT', 'Waktu habis')), timeoutMs);
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end();
  });
}

/**
 * `isAllowedIp` & `allowedPorts` bisa diganti HANYA lewat parameter kode ini (dipakai test buat nembak server lokal).
 * Gak ada env var / opsi runtime yang bisa mematikan pengecekan IP/port di instance default.
 */
function createSafeFetcher({ isAllowedIp = isPublicIp, allowedPorts = [80, 443] } = {}) {
  const lookup = makeGuardedLookup(isAllowedIp);

  /**
   * @returns {Promise<{ok:boolean,status:number,contentType:string,body:Buffer,truncated?:boolean,finalUrl:string,skipped?:string}>}
   */
  async function get(
    urlStr,
    { timeoutMs = 5000, maxBytes = 1500000, maxRedirects = 3, signal, headers = {}, acceptTypes = TEXT_TYPES } = {}
  ) {
    const deadline = Date.now() + timeoutMs;
    let current = urlStr;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const u = parseAndValidate(current, isAllowedIp, allowedPorts);
      const res = await requestOnce(u, {
        lookup,
        timeoutMs: deadline - Date.now(),
        maxBytes,
        signal,
        headers,
        acceptTypes,
      });
      if (res.redirect) {
        try {
          current = new URL(res.redirect, u).toString();
        } catch (_) {
          throw new SafeFetchError('BAD_URL', 'Redirect ke URL tidak valid');
        }
        continue;
      }
      return { ...res, finalUrl: u.toString() };
    }
    throw new SafeFetchError('TOO_MANY_REDIRECTS', 'Terlalu banyak redirect');
  }

  return { get };
}

const defaultFetcher = createSafeFetcher();

module.exports = {
  createSafeFetcher,
  safeGet: defaultFetcher.get,
  isPublicIp,
  parseIPv6,
  SafeFetchError,
  TEXT_TYPES,
};
