'use strict';

/**
 * Header keamanan dasar buat API JSON/SSE. SENGAJA gak pakai library (mis. Helmet) apa adanya
 * dengan default-nya — beberapa default library security itu didesain buat halaman HTML dan
 * bisa DIAM-DIAM MERUSAK API yang memang harus diakses cross-origin (contoh nyata:
 * `Cross-Origin-Resource-Policy: same-origin` adalah default umum di banyak library, tapi kalau
 * dipasang di sini bakal bikin frontend OxyChat—yang genuinely beda origin dari backend ini—gagal
 * fetch). Makanya headernya dipilih manual, satu-satu, sesuai kebutuhan API ini.
 */
function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    // Cross-origin SENGAJA diizinkan (bukan 'same-origin') — API ini memang dipanggil dari
    // origin lain (frontend OxyChat di domain berbeda).
    'Cross-Origin-Resource-Policy': 'cross-origin',
    // Aman dikirim walau lagi HTTP polos (browser cuma menghormati ini di koneksi HTTPS),
    // dan berguna begitu di-deploy di belakang HTTPS (Railway/Render/Fly.io/reverse proxy).
    'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
  });
  next();
}

module.exports = securityHeaders;
