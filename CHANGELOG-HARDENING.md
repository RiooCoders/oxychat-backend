# OxyChat Backend Hardening — Changelog

Lihat `SECURITY-AUDIT.md` untuk detail teknis tiap temuan (root cause, impact, exploit scenario,
regression test). File ini fokus ke ringkasan perubahan + dokumentasi migrasi kontrak.

## Fixed

- **[CRITICAL]** API key ownership bisa dipalsukan lewat `createdBy` (IDOR) — sekarang identitas
  user yang login diverifikasi lewat Supabase, bukan dipercaya mentah dari client.
- **[CRITICAL]** API key mentah (plaintext) dibalikin berkali-kali lewat `GET /api/keys` —
  sekarang cuma preview yang dimasking; key lengkap cuma muncul sekali pas dibuat.
- **[HIGH]** `/v1/chat` tidak punya rate limit — sekarang 2 lapis (per API key + per IP).
- **[HIGH]** Limit pembuatan API key & `maxUses` redeem code berpotensi race condition kalau
  suatu saat di-scale lintas proses — sekarang dibungkus transaksi database beneran.
- **[HIGH]** Tidak ada header keamanan dasar — ditambahkan (dipilih manual, bukan default library,
  biar gak merusak akses cross-origin dari frontend).
- **[MEDIUM]** Error `/api/redeem` & `/api/chat` tidak punya request ID buat korelasi log —
  ditambahkan `X-Request-Id` + field `requestId` di tiap error.
- **[MEDIUM]** `X-Device-Id` tidak divalidasi bentuknya — sekarang ada batas wajar (panjang, non-kosong).

## Added

- Verifikasi identitas via Supabase Auth (`src/services/supabase-auth.service.js`,
  `src/middleware/optional-supabase-auth.js`) — opsional, kompatibel ke belakang buat user anonim.
- Transaksi database (`src/db/database.js: transaction()`) dipakai di pembuatan API key & redeem.
- Rate limit `/v1/chat` per-key & per-IP independen (`V1_CHAT_RATE_LIMIT_PER_KEY/_IP`).
- Limit pembuatan API key per identitas owner (`API_KEY_LIMIT_PER_OWNER`, default 1x sesuai
  `PLANS.*.keyLimit` di frontend — dikonfirmasi flat 1x buat SEMUA plan, bukan cuma gratis).
- Header keamanan dasar (`src/middleware/security-headers.js`).
- Request ID per request (`X-Request-Id`, dipakai di log & error body).
- **Automated test suite** (`tests/`, `node:test` bawaan, `npm test`) — 79 test, termasuk 2 test
  konkurensi asli (bukan simulasi) yang membuktikan race condition di atas beneran tertutup.
- `SECURITY-AUDIT.md` — laporan audit format Finding/Severity/RootCause/Impact/Fix/Verification.

## Perubahan kontrak frontend (WAJIB baca sebelum deploy)

Sesuai instruksi MASTER PROMPT ("jangan mengubah kontrak tanpa dokumentasi migrasi"), 2 celah
CRITICAL di atas TIDAK BISA ditutup tanpa perubahan kecil di frontend (backend saja tidak cukup,
karena masalahnya justru backend selama ini *terlalu percaya* apa yang dikirim frontend). Kedua
perubahan berikut package Supabase JS SDK yang sama seperti `chat/js/00-supabase.js`.

### 1. `chat/CreateApikey/index.html`

- **OLD**: cuma load `script.js`, tanpa Supabase SDK.
- **NEW**: tambah `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>`
  SEBELUM `script.js` (persis versi yang sama dipakai `chat/index.html`). Ditambah 1 baris
  keterangan di atas daftar riwayat, kasih tau kenapa cuma preview key yang keliatan.
- **REASON**: `script.js` butuh `window.supabase.createClient(...)` buat ambil sesi login yang
  aktif dan verifikasi API key ownership beneran (lihat CRITICAL-1 di SECURITY-AUDIT.md).
- **IMPACT**: nol untuk user yang belum login (jalur anonim gak kepengaruh). User yang lagi login,
  API key-nya sekarang BENERAN terikat ke akun mereka (gak bisa dipalsukan lewat email orang lain).
- **MIGRATION**: cukup deploy ulang file HTML ini bareng `script.js` yang baru. Gak ada perubahan
  data/backend yang perlu dijalanin manual.

### 2. `chat/CreateApikey/script.js`

- **OLD**: `getOwnerId()` doang, kirim `createdBy` apa adanya ke semua request `/api/keys*`;
  `loadHistory()` nampilin `k.key` (key MENTAH) di daftar riwayat.
- **NEW**: tambah `getAuthHeaders()` — ambil sesi Supabase aktif (`sb.auth.getSession()`, sesi
  yang SAMA yang dibikin halaman utama, karena Supabase SDK nyimpen sesi di localStorage sendiri
  lintas halaman) dan kirim `Authorization: Bearer <access_token>` di request create/list/delete
  KALAU user lagi login. `createdBy` TETAP dikirim juga (buat kompatibilitas/fallback anonim, dan
  gak masalah dikirim meski diabaikan server pas ada token valid). `loadHistory()` sekarang baca
  `k.keyPreview` (bukan `k.key`) buat ditampilin.
- **REASON**: sama seperti di atas — mengaktifkan verifikasi ownership beneran, dan
  mengikuti perubahan kontrak `GET /api/keys` (`key` penuh → `keyPreview` termasker).
- **IMPACT**:
  - User yang login: API key-nya sekarang aman dari IDOR, dan gak akan lagi keliatan key mentah
    berkali-kali di riwayat (cuma sekali pas dibuat, sesuai praktik "show once" yang wajar).
  - User anonim/trial (belum login): TIDAK ADA perubahan perilaku — `getAuthHeaders()` balikin
    object kosong kalau gak ada sesi, jadi jalur lama (createdBy = device id) tetap berfungsi PERSIS
    seperti sebelumnya.
  - Key yang dibuat SEBELUM patch ini (owner tersimpan sebagai email polos) TETAP kebaca normal
    buat user yang sama setelah mereka login (server mencocokkan baik `supabase:<uuid>` maupun
    email yang terikat ke sesi itu — lihat `resolveOwnerContext` di `api-key.service.js`) — bukan
    silent data loss.
- **MIGRATION**: deploy file baru. Tidak perlu migrasi data manual — kompatibilitas mundur
  ditangani otomatis oleh backend (lihat poin di atas). Kalau mau, key lama BOLEH (opsional, tidak
  wajib) di-"upgrade" belakangan supaya field `owner`-nya seragam `supabase:<uuid>`, tapi ini
  bukan prasyarat supaya sistem tetap jalan benar.

## Perubahan kontrak API (backend)

| Endpoint | Field | OLD | NEW | Breaking? |
|---|---|---|---|---|
| `GET /api/keys` | `key` → `keyPreview` | key lengkap (`oxy_...40 karakter`) | preview termasker (`oxy_AbCd…WxYz`) | Ya, buat konsumen yang baca field ini langsung — makanya frontend ikut di-update di changelog ini. `POST /api/keys` (create) TIDAK berubah, tetap balikin `key` lengkap. |
| `POST /api/keys` | — | terima `createdBy` apa adanya | terima `createdBy` ATAU `Authorization: Bearer <supabase_token>`; kalau `createdBy` berbentuk email TANPA token, ditolak 401 `EMAIL_OWNER_REQUIRES_AUTH` | Cuma buat pola pemakaian yang sebelumnya adalah CELAH KEAMANAN (klaim email orang lain tanpa bukti) — pemakaian sah user asli tidak terdampak (device-id anonim tetap jalan, email SAH via sesi login sekarang malah lebih benar). |
| `POST\|GET\|DELETE /api/keys*` | — | limit pembuatan key: tidak ditegakkan server | limit 1x per owner (`API_KEY_LIMIT_PER_OWNER`), balikin 409 `API_KEY_LIMIT_REACHED` kalau kelebihan | Baru — sebelumnya user bisa bikin key tanpa batas lewat direct API call (UI-nya sendiri gak ada tombol buat itu, jadi user normal lewat UI tidak terdampak). |
| `POST /v1/chat` | — | tidak ada rate limit | 429 kalau lewat batas per-key/per-IP | Cuma berdampak ke pemakaian di luar batas wajar (default 60/menit per key, 120/menit per IP — jauh di atas pemakaian normal). |
| semua response error | `error.requestId` | tidak ada | field baru, aditif | Tidak breaking (field tambahan, bukan pengganti). |
