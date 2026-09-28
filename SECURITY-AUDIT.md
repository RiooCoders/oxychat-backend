# OxyChat Backend — Security & Reliability Audit

Audit ini dilakukan terhadap backend hasil rekonstruksi (lihat `README.md`) sesuai
`MASTER PROMPT — BACKEND SECURITY HARDENING + BUG FIX + PRODUCTION AUDIT`. Prioritas sumber
kebenaran: frontend asli (`chat/js/*.js`, `chat/CreateApikey/*`) > backend hasil rekonstruksi >
`supabase-schema.sql` > kontrak yang benar-benar dipanggil frontend.

Metodologi: setiap temuan di bawah diverifikasi dengan MEMBACA ULANG source code asli (bukan
ditebak dari ingatan) sebelum fix ditulis, dan setiap fix diverifikasi dengan test otomatis nyata
(`npm test` — 79 test, semuanya lulus per commit ini) memakai server tiruan yang niru format
OpenAI-compatible & Supabase Auth API. **Tidak ada fix yang diklaim tanpa bukti test.**

## === AUDIT SUMMARY (putaran ke-2, lanjutan MASTER PROMPT V3) ===

| Severity | Jumlah |
|---|---|
| CRITICAL | 3 (+1 baru: CRITICAL-3, Phase 1 & 2 SUDAH diimplementasikan) |
| HIGH | 5 (+2 baru: HIGH-4, HIGH-5 — keduanya SUDAH diimplementasikan) |
| MEDIUM | 3 |
| LOW | 2 |

CRITICAL-3, HIGH-4, dan HIGH-5 di bawah adalah temuan BARU dari putaran audit lanjutan (bukan
bagian dari 79 test/putaran audit sebelumnya) — SEMUANYA sudah ada fix-nya di putaran ini (bukan
cuma didokumentasikan). CRITICAL-3 sesuai "CRITICAL-01" + sebagian "HIGH-03" di MASTER PROMPT V3
(plus 1 bug baru — negative-amount pada `deduct_credit` — yang tidak disebutkan eksplisit di
master prompt tapi ditemukan lewat pembacaan ulang `supabase-schema.sql`). HIGH-4 sesuai bagian
rate-limit dari "HIGH-02". HIGH-5 sesuai "HIGH-04" (API key secret storage). **PENTING**: fix CRITICAL-3 (file `fix-critical-plan-credit-rpc.sql`,
dijalankan terpisah di Supabase SQL Editor) TIDAK BISA diverifikasi lewat `npm test` di sini
karena murni SQL/Supabase — tidak ada `node:test` yang menjalankan Postgres. Fix HIGH-4 ADA
testnya (`tests/rate-limit-chat-ip.test.js`) tapi **tidak bisa dieksekusi di lingkungan audit
lanjutan ini** karena `node_modules` tidak tersedia dan registry npm diblokir (beda dari audit
putaran pertama yang setidaknya bisa `npm install` sebelum internet dicabut) — jalankan
`npm install && npm test` di mesin dengan akses internet sebelum deploy.

- **FRONTEND BUGS**: 0 (tidak ditemukan bug murni di frontend yang di luar scope kontrak ini)
- **BACKEND BUGS**: 2 (API key ownership IDOR, redeem/API-key race condition berpotensi — lihat CRITICAL-1 & MEDIUM-1)
- **CONTRACT MISMATCH**: 1 (lihat MEDIUM-2 — `oxy-vision` alias vs `VISION_MODEL` asli, sudah didokumentasikan sejak audit awal, dipertahankan apa adanya)
- **SECURITY ISSUES**: CRITICAL-1, CRITICAL-2, HIGH-1, HIGH-2, HIGH-3
- **MODEL ISSUES**: MEDIUM-2 (lihat README bagian "Provider & model mapping")
- **DATABASE ISSUES**: MEDIUM-1 (race condition, sudah diperbaiki dengan transaksi)
- **TESTING GAPS**: sebelum audit ini, TIDAK ADA automated test yang ikut dikirim sebagai bagian
  deliverable (cuma diverifikasi manual sekali saat pembuatan). Sekarang: 79 test di `tests/`,
  jalan tiap saat lewat `npm test`.

---

## CRITICAL-1: API key ownership bisa dipalsukan (IDOR)

- **SEVERITY**: CRITICAL
- **FILE**: `src/services/api-key.service.js`, `src/controllers/keys.controller.js` (sebelum fix)
- **FUNCTION**: `createApiKey`, `listApiKeys`, `deleteApiKey`
- **ROOT CAUSE**: Ownership API key 100% dipercaya dari field `createdBy` yang dikirim client apa
  adanya, tanpa verifikasi apa pun. Dikonfirmasi lewat pembacaan ulang
  `chat/CreateApikey/script.js`: `getOwnerId()` cuma baca `localStorage.getItem('oxychat_useremail_v1')`
  (string polos, bukan token/sesi apa pun) dan mengirimnya sebagai `createdBy`.
- **IMPACT**: Siapa pun yang tahu/menebak email seseorang bisa memanggil
  `GET /api/keys?createdBy=victim@email.com` atau `DELETE /api/keys/:id?createdBy=victim@email.com`
  langsung lewat `curl`/Postman dan **melihat serta menghapus API key milik orang lain**, tanpa
  perlu login sama sekali.
- **EXPLOIT SCENARIO**: `curl "$SERVER/api/keys?createdBy=victim@email.com"` — balikin semua key
  aktif milik `victim@email.com` (sebelum fix ini, termasuk plaintext key-nya — lihat HIGH-1).
- **FIX**: `src/services/supabase-auth.service.js` (baru) — verifikasi `Authorization: Bearer
  <supabase_access_token>` lewat `GET {SUPABASE_URL}/auth/v1/user` (endpoint resmi Supabase,
  bukan verifikasi JWT lokal — lihat alasan teknisnya di komentar file tsb).
  `src/middleware/optional-supabase-auth.js` (baru) — pasang identitas terverifikasi ke
  `req.supabaseUser` kalau ada token valid; **tolak (401)** kalau ada token tapi invalid (gak
  diem-diem dianggap anonim); kalau gak ada header sama sekali, lanjut sebagai anonim (kompatibel
  ke belakang).
  `src/services/api-key.service.js` (`resolveOwnerContext`) — kalau `req.supabaseUser` ada,
  itu yang jadi identitas asli (`owner = "supabase:<uuid>"`), **createdBy dari client diabaikan
  total**. Kalau gak ada token DAN `createdBy` berbentuk email, **request ditolak (401,
  `EMAIL_OWNER_REQUIRES_AUTH`)** — email cuma sah jadi identitas kalau didukung sesi asli. Kalau
  `createdBy` BUKAN email (device-id anonim `anon-xxxxx`), tetap dipercaya seperti semula (jalur
  trial, disengaja tetap lemah sesuai catatan MASTER PROMPT soal device-id).
- **FRONTEND IMPACT & PERUBAHAN**: `chat/CreateApikey/index.html` & `chat/CreateApikey/script.js`
  diubah — lihat entri "Added" di `CHANGELOG-HARDENING.md` untuk detail FILE/OLD/NEW/REASON.
  Intinya: halaman ini sekarang ikut memuat Supabase JS SDK (sama seperti halaman utama) dan
  mengirim `Authorization: Bearer <access_token>` kalau user lagi login — otomatis dapet sesi yang
  sama (Supabase SDK nyimpen sesi di localStorage sendiri, lintas halaman di origin yang sama).
- **REGRESSION TEST**: `tests/auth.test.js` (8 skenario: email tanpa token ditolak, device-id
  anonim tetap jalan, token invalid ditolak, token valid dipakai & createdBy klaim diabaikan,
  user lain gak bisa lihat/hapus key user lain walau pake token sendiri, **key lama yang owner-nya
  masih format email tetap kebaca setelah user login** — migrasi kompatibel, bukan silent data loss).

## CRITICAL-2: API key mentah (plaintext) dibalikin berkali-kali lewat listing

- **SEVERITY**: CRITICAL
- **FILE**: `src/services/api-key.service.js` (sebelum fix)
- **ROOT CAUSE**: `GET /api/keys` mengembalikan field `key` berisi secret LENGKAP, bukan cuma
  sekali pas dibuat — tiap kali halaman riwayat dibuka, semua key aktif (plaintext) ikut terkirim
  lagi. Dikombinasikan dengan CRITICAL-1 (ownership gak diverifikasi), ini artinya siapa pun yang
  bisa nebak `createdBy` orang lain otomatis dapet **key mentah** orang itu, bukan cuma metadata.
- **IMPACT**: Kebocoran credential (API key = akses penuh ke `/v1/chat` orang lain, kena beban
  biaya/kuota provider dari akun orang lain).
- **FIX**: `api-key.service.js` — `GET /api/keys` sekarang balikin `keyPreview` (mis.
  `oxy_AbCd…WxYz`, 8 karakter awal + 4 akhir), **bukan** `key` mentah. `POST /api/keys` (saat
  create) TETAP balikin `key` lengkap — ini "show once" yang semestinya, satu-satunya momen
  wajar buat nunjukin secret utuh.
- **FRONTEND IMPACT & PERUBAHAN**: `chat/CreateApikey/script.js` — `loadHistory()` sekarang baca
  `k.keyPreview` (bukan `k.key`) buat ditampilin di riwayat. Ditambah 1 baris keterangan di
  `chat/CreateApikey/index.html` biar user gak bingung kenapa cuma keliatan sepotong. Tombol
  "copy" di hasil pembuatan key (bukan di riwayat) TIDAK terpengaruh — itu tetap nyalin key
  lengkap dari momen create, sesuai desain semula.
- **REGRESSION TEST**: `tests/api-key.test.js` ("list ... key mentah TIDAK muncul lagi").

## CRITICAL-3: `set_user_plan` & `deduct_credit` (Supabase RPC) bisa dieksploitasi langsung dari browser (BUKAN bug backend Node — di luar `src/`)

- **SEVERITY**: CRITICAL
- **FILE**: `supabase-schema.sql`, `fix-credit-bug.sql` (di repo FRONTEND, bukan backend ini —
  backend Node ini tidak pernah memanggil RPC kredit/plan sama sekali, lihat bagian "Yang SUDAH
  diaudit" di bawah).
- **ROOT CAUSE**: Kedua RPC ini `security definer` dan bisa dipanggil LANGSUNG dari browser lewat
  `sb.rpc(...)` (client Supabase JS yang sama yang dipakai `chat/js/00-supabase.js`) memakai sesi
  login user sendiri — tidak ada REVOKE/GRANT yang membatasi siapa boleh manggil, dan tidak ada
  validasi input di dalam function:
  1. `set_user_plan(p_plan, p_credit_awal, p_credit_harian)` menerima KETIGA parameter apa adanya
     dari client. Dikonfirmasi lewat `chat/js/00-supabase.js` (`sbSetUserPlan`) &
     `04-account-settings.js` (`confirmPlanSelection`, `submitRedeemCode`) bahwa satu-satunya
     pemanggil SAH dari UI cuma untuk plan `'gratis'` (paket berbayar masih `plan-box-locked` di
     `chat/index.html`, nunggu payment gateway — belum ada integrasi pembayaran apa pun). Tapi
     karena function-nya sendiri tidak menolak plan lain, siapa pun yang login bisa panggil
     manual `sb.rpc('set_user_plan',{p_plan:'promax', p_credit_awal:999999999, ...})` dari
     browser devtools dan LANGSUNG dapat plan+kredit sebesar itu. Lebih parah lagi: klausa
     `elsif v_current_plan is distinct from p_plan` menambah `credit_awal_sisa` TIAP KALI plan
     berbeda dari sebelumnya — jadi gonta-ganti `p_plan` ke 2 nilai bolak-balik ('x'/'y', atau
     'pro'/'maks' bolak-balik) memberi kredit TANPA BATAS pada tiap panggilan, bukan cuma sekali.
  2. `deduct_credit(p_amount)` — BARU DITEMUKAN di audit lanjutan ini, tidak ada di daftar
     master prompt — tidak menolak `p_amount` negatif. Ditelusuri manual: dengan
     `p_amount = -1000000`, `v_take_harian := least(v_harian, p_amount)` menghasilkan angka
     negatif, dan `credit_harian_sisa - v_take_harian` (kurang dikurangi angka negatif = ditambah)
     membuat `credit_harian_sisa` NAIK 1.000.000, bukan berkurang. `chat/js/00-supabase.js`
     (`sbDeductCredit`) memang sudah cek `amount <= 0` sebelum manggil RPC, tapi itu validasi
     client-side saja — RPC-nya sendiri tetap bisa dipanggil langsung lewat devtools/curl dengan
     sesi user sendiri, melewati App sepenuhnya.
- **IMPACT**: Setiap user yang login bisa memberi diri sendiri plan tertinggi + kredit berapa pun
  secara instan dan berulang, tanpa redeem code maupun pembayaran apa pun — privilege escalation
  penuh terhadap sistem kredit/plan.
- **FIX**: `fix-critical-plan-credit-rpc.sql` (file terpisah, jalankan di Supabase SQL Editor —
  BUKAN bagian dari deploy backend Node ini karena memang bukan di database backend ini):
  - `set_user_plan`: hanya melayani `p_plan = 'gratis'` dengan angka HARDCODE di server (500/10,
    sesuai `CREDIT_DEFS.gratis` frontend) — parameter kredit dari client sekarang diabaikan
    total. Plan lain di-`raise exception`.
  - `deduct_credit`: menolak `p_amount` yang bukan bilangan bulat positif wajar (0 < x ≤ 50000).
  - `revoke execute ... from public` + `grant ... to authenticated` di kedua function (defense
    in depth; validasi di dalam function tetap proteksi utama).
- **DAMPAK SAMPING YANG DISENGAJA (perlu diketahui sebelum deploy)**: redeem code bertipe
  `"plan"` (pro/maks/promax) validasinya di backend Node TETAP benar dan aman (lihat HIGH-3 asli
  master prompt — sudah diverifikasi solid), TAPI baris terakhir alur lama (frontend manggil
  `sbSetUserPlan()` buat benar-benar naikin plan di Supabase setelah redeem sukses) akan DITOLAK
  oleh function yang sudah diperbaiki ini. Artinya **redeem code tipe plan berhenti berfungsi
  penuh** sampai jembatan server-to-server (Node -> Supabase pakai `service_role` key, BELUM
  diimplementasikan di putaran ini) dibangun. Ini trade-off yang disengaja: menutup lubang privesc
  lebih diprioritaskan daripada mempertahankan fitur yang justru selama ini bergantung pada lubang
  yang sama. Redeem tipe `"unlock_model"` TIDAK terpengaruh (tidak lewat Supabase).
- **REGRESSION TEST**: TIDAK BISA `node:test` (murni SQL) — diverifikasi lewat penelusuran manual
  step-by-step logic di atas (dituliskan di komentar SQL file), bukan eksekusi otomatis. Perlu
  divalidasi manual di Supabase SQL Editor / staging project sebelum production.

### UPDATE — CRITICAL-3 Phase 2 (jembatan redeem -> Supabase, sudah diimplementasikan)

Dampak samping di atas (redeem plan berhenti berfungsi) SEKARANG SUDAH DITANGANI:
- **SQL baru**: `phase2-admin-grant-plan-rpc.sql` — function `admin_grant_plan(p_user_id, p_plan,
  p_credit_awal, p_credit_harian)`, `security definer`, EXECUTE dicabut dari `public`/`anon`/
  `authenticated`, HANYA digrant ke `service_role`. Sengaja TIDAK memvalidasi nilai p_plan/
  p_credit_* di dalam SQL (beda dari `set_user_plan`) karena trust boundary-nya bukan "nilai apa
  yang dikirim", tapi "siapa yang bisa manggil sama sekali" — cuma backend Node yang pegang
  `SUPABASE_SERVICE_ROLE_KEY` (rahasia, server-only).
- **Backend baru**: `src/services/supabase-admin.service.js` (fetch POST ke
  `/rest/v1/rpc/admin_grant_plan` pakai service_role key, tanpa dependency SDK baru).
- **`redeem.service.js` direstruktur jadi 2 tahap** (karena `db.transaction()` di
  `db/database.js` WAJIB sinkron — network call ke Supabase gak boleh nahan write-lock DB):
  1. Transaksi sinkron: validasi kode (SAMA seperti sebelumnya) + WAJIB `supabaseUser` kalau
     `type==='plan'` (ditolak SEBELUM kode ditandai kepake kalau belum login — kode gak
     "terbakar" sia-sia) → tandai kepake, simpan `grantStatus:'pending'` + `userId`.
  2. Di luar transaksi: panggil `grantPlanForUser`. Sukses → `grantStatus:'granted'`, response
     sukses ke client (persis kontrak lama). Gagal → `grantStatus:'failed'`, response ERROR ke
     client (jujur — bukan diam-diam diklaim sukses), kode TETAP tercatat kepake (gak bisa
     direbut ulang device lain), tapi bisa dipulihkan lewat `node scripts/admin.js retry-grant
     --code=... --device=...` (pakai `userId` yang udah kesimpen) TANPA user redeem ulang.
- **`/api/redeem` sekarang pakai `optionalSupabaseAuth`** (persis middleware yang sama dengan
  `/api/keys`) — kode tipe `unlock_model`/`generic` TETAP jalan tanpa login (gak ada regresi
  produk buat tipe itu), cuma tipe `plan` yang sekarang wajib login.
- **BREAKING CHANGE terdokumentasi**: redeem kode tipe `plan` TANPA header `Authorization`
  sekarang ditolak (sebelumnya jalan tanpa login). Frontend (`04-account-settings.js`) sudah
  disesuaikan: mengirim `Authorization: Bearer <access_token>` kalau sedang login, dan tidak lagi
  memanggil `sbSetUserPlan()` sendiri untuk hasil redeem tipe plan (backend yang menerapkan lewat
  service_role; frontend tinggal `sbFetchProfile()` buat menampilkan perubahan yang sudah terjadi).
- **REGRESSION TEST**: `tests/redeem.test.js` — ditambah 3 skenario (plan sukses dengan login +
  verifikasi isi RPC yang dikirim ke Supabase, plan tanpa login ditolak tapi TIDAK membakar kode
  jadi bisa dicoba lagi setelah login, grant Supabase gagal → error jujur + `grantStatus:'failed'`
  + kode tetap tercatat kepake). `tests/helpers/harness.js` diperluas: mock Supabase sekarang juga
  melayani `/rest/v1/rpc/admin_grant_plan` (`mockSupabase.grants` buat inspeksi,
  `setGrantShouldFail()` buat simulasi gagal). **Sama seperti seluruh test lain di lingkungan
  audit lanjutan ini**: sintaks sudah divalidasi (`node --check`) dan dikonfirmasi gagal tepat di
  titik yang sama (`Cannot find module 'express'`) karena `node_modules` tidak tersedia di sini —
  BELUM PERNAH benar-benar PASS. Jalankan `npm install && npm test` sebelum deploy.
- **Belum ditangani (di luar scope hardening ini)**: retry-grant lewat CLI itu sendiri (argv
  parsing, exit code) tidak punya test tersendiri — cuma logic inti (repo + service) yang dites.
  Kalau operator butuh jaminan lebih, tambahkan test terpisah buat `scripts/admin.js`.

## HIGH-1: `/v1/chat` tidak punya rate limit sama sekali

- **SEVERITY**: HIGH
- **FILE**: `src/routes/public.routes.js` (sebelum fix)
- **ROOT CAUSE**: Endpoint publik yang bisa dipanggil siapa saja pemegang API key — tidak ada
  pembatas laju request apa pun. Satu key yang disalahgunakan (bocor/dicuri) bisa menghajar
  provider AI tanpa batas, jadi tagihan/kuota provider bisa membengkak.
- **IMPACT**: Kerugian biaya provider, potensi denial-of-service ke provider hingga kena block.
- **FIX**: `src/routes/public.routes.js` — 2 lapis independen: per-IP (`V1_CHAT_RATE_LIMIT_PER_IP`,
  default 120/menit, jalan SEBELUM auth) dan per-API-key (`V1_CHAT_RATE_LIMIT_PER_KEY`, default
  60/menit, jalan SETELAH auth berhasil, di-key oleh id key bukan string key mentah).
- **REGRESSION TEST**: `tests/rate-limit-v1-per-key.test.js`, `tests/rate-limit-v1-per-ip.test.js`
  (2 key independen, IP limit tetep jalan walau autentikasi gagal berkali-kali).

## HIGH-2: Race condition — limit pembuatan API key & redeem code bisa dilewati

- **SEVERITY**: HIGH (bukan CRITICAL karena dampaknya "cuma" lolos limit produk, bukan kebocoran data)
- **FILE**: `src/services/api-key.service.js`, `src/services/redeem.service.js` (sebelum fix)
- **ROOT CAUSE**: Pola "SELECT/hitung dulu, baru INSERT/UPDATE" tanpa transaksi eksplisit. Untuk
  proses Node tunggal, ini SEBENARNYA sudah "kebetulan" aman (JS single-thread, kedua fungsi
  sepenuhnya sinkron tanpa `await` di antara cek dan tulis — sudah diverifikasi lewat test
  konkurensi asli, bukan cuma dianggap aman), TAPI itu bergantung pada asumsi 1 proses/1 koneksi
  DB yang tidak dijamin selamanya (mis. kalau suatu saat di-scale ke beberapa proses berbagi 1
  file SQLite).
- **IMPACT**: Kalau asumsi single-process berubah tanpa disadari, limit key (1x) dan `maxUses`
  redeem code bisa dilewati oleh request paralel.
- **FIX**: `src/db/database.js` menambah `transaction(fn)` (SQLite: `BEGIN IMMEDIATE` beneran,
  narik write-lock dari awal; JSON fallback: dijalanin langsung, API disamain). Dipakai di
  `api-key.service.js` (cek limit + insert) dan `redeem.service.js` (cek + increment + record)
  supaya check-then-write atomik di level DATABASE, bukan cuma "kebetulan aman" di level proses.
- **REGRESSION TEST**: `tests/api-key.test.js` (10 request `Promise.all` bikin key owner sama,
  limit=1 → PERSIS 1 sukses) dan `tests/redeem.test.js` (10 request `Promise.all` redeem kode
  `maxUses=1` dari device beda-beda → PERSIS 1 sukses) — **dites beneran dengan concurrency asli**,
  bukan diasumsikan, sesuai MASTER PROMPT bagian 29.

## HIGH-3: Tidak ada header keamanan dasar

- **SEVERITY**: HIGH
- **FILE**: `src/app.js` (sebelum fix)
- **ROOT CAUSE**: Response gak punya `X-Content-Type-Options`, `X-Frame-Options`, dst.
- **IMPACT**: Rendah untuk API JSON murni, tapi ini defense-in-depth standar yang murah buat
  dipasang dan diminta eksplisit oleh MASTER PROMPT.
- **FIX**: `src/middleware/security-headers.js` (baru) — HAND-ROLLED (bukan library kayak Helmet
  apa adanya) justru karena default beberapa library (mis. `Cross-Origin-Resource-Policy:
  same-origin`) akan DIAM-DIAM MERUSAK API ini yang memang harus diakses cross-origin dari
  frontend. Header dipilih manual: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
  `Cross-Origin-Resource-Policy: cross-origin` (bukan same-origin), `Strict-Transport-Security`.
- **REGRESSION TEST**: `tests/security.test.js`.

## HIGH-4: Rate limit `/api/chat` bisa dilewati dengan gonta-ganti `X-Device-Id`

- **SEVERITY**: HIGH
- **FILE**: `src/routes/chat.routes.js` (sebelum fix), `src/config/env.js`
- **ROOT CAUSE**: Limiter lama key-nya `req.get('x-device-id') || req.ip` — karena
  `X-Device-Id` dikirim mentah oleh client dan tidak diverifikasi (bukan authentication, cuma
  anti-abuse ringan sesuai desain awal), client yang kirim header BEDA di tiap request dapat
  bucket rate-limit BARU tiap kali dan melewati limit `CHAT_RATE_LIMIT_PER_MIN` sepenuhnya. Ini
  persis skenario yang diminta dicegah eksplisit oleh MASTER PROMPT HIGH-02: "Prevent clients
  from bypassing quota restrictions by repeatedly changing device identifiers." Beda dengan
  `/v1/chat` (`public.routes.js`) yang dari audit sebelumnya SUDAH benar (limiter per-IP-nya
  dikunci ke `req.ip` doang, gak baca header apa pun), `/api/chat` belum. Anonymous chat sendiri
  dikonfirmasi MEMANG desain produk yang disengaja (frontend tidak pernah mengirim token Supabase
  ke endpoint ini sama sekali — bukan celah, itu kontrak yang ada), jadi fix-nya BUKAN
  mewajibkan login, tapi bikin proteksi kuota anonimnya beneran tahan terhadap spoofing header.
- **IMPACT**: Satu client (device/skrip) bisa membanjiri `/api/chat` tanpa batas efektif hanya
  dengan mengganti 1 header per request — biaya provider AI bisa membengkak tak terkendali dari
  1 sumber, sama seperti kalau rate limit-nya tidak ada sama sekali.
- **FIX**: Tambah lapis KEDUA yang WAJIB dan dikunci `req.ip` SAJA (`CHAT_RATE_LIMIT_PER_IP`,
  default 180/menit — lebih longgar dari limit device/IP lama karena 1 IP publik bisa dipakai
  banyak user asli sekaligus lewat NAT/kantor/kampus), dijalankan SEBELUM limiter device-id/IP
  lama yang tetap dipertahankan apa adanya (masih berguna buat granularitas per-device di
  belakang IP yang sama). Pola persis sama seperti `/v1/chat` yang sudah terbukti benar.
- **REGRESSION TEST**: `tests/rate-limit-chat-ip.test.js` (2 skenario: device-id digonta-ganti
  tiap request tetap kena limit per-IP; device-id konsisten tetap kena limit lama seperti
  sebelumnya — regresi negatif). **Catatan jujur**: ditulis mengikuti pola persis
  `rate-limit-v1-per-ip.test.js` yang sudah ada dan diverifikasi `node --check` (sintaks valid)
  serta dikonfirmasi gagal tepat di titik yang sama (`Cannot find module 'express'`) seperti
  semua test lain di lingkungan audit lanjutan ini — TAPI belum pernah benar-benar PASS di sini
  karena `node_modules` tidak ada dan registry npm diblokir (lihat AUDIT SUMMARY). Jalankan
  `npm install && npm test` sebelum deploy untuk konfirmasi PASS sebenarnya.

## HIGH-5: API key masih disimpan plaintext di database (storage-at-rest)

- **SEVERITY**: HIGH
- **FILE**: `src/services/api-key.service.js`, `src/db/repositories/apikey.repo.js` (sebelum fix)
- **ROOT CAUSE**: CRITICAL-2 (di atas) sudah nutup kebocoran lewat endpoint LISTING (gak lagi
  nampilin key mentah berkali-kali), tapi storage-nya sendiri masih plaintext — `findByKey`
  ngebandingin `r.key === key` LANGSUNG ke field yang disimpan apa adanya. Kalau file database
  ini (SQLite/JSON) bocor lewat cara apa pun (backup gak sengaja ke-expose, path traversal,
  akses filesystem gak sengaja, dst), SEMUA API key user langsung bisa dipakai orang lain,
  gak perlu di-crack sama sekali.
- **IMPACT**: Kebocoran file database = kebocoran seluruh API key aktif secara langsung.
- **FIX**: `createApiKey` sekarang nyimpen `keyHash` (SHA-256 dari key mentah) + `keyPreview`
  (8 char depan + 4 char belakang, dihitung SEKALI pas dibuat) — bukan `key` mentah sama sekali.
  Key mentah cuma ada sesaat di response `POST /api/keys` (kontrak lama TETAP sama persis:
  `{key: "oxy_..."}`), gak pernah disimpan. `resolveKeyForAuth` (dipakai auth `/v1/chat`) hash
  key yang dikirim client lalu cari berdasarkan hash itu, BUKAN perbandingan string langsung ke
  plaintext. SHA-256 polos (bukan bcrypt/argon2) sengaja dipilih karena beda dari password manusia
  — key ini >200 bit entropy dari CSPRNG asli, brute-force gak feasible apa pun cost function-nya
  (detail lengkap di komentar `utils/id.js`).
- **KOMPATIBILITAS KEY LAMA**: row yang dibuat SEBELUM fix ini (masih plaintext, belum ada
  `keyHash`) TETAP bisa auth lewat fallback transisi (`apikey.repo.js` `findByRawKeyLegacy`) —
  gak ada key yang mendadak invalid begitu backend baru di-deploy. `scripts/migrate-api-key-hashes.js`
  (baru) buat convert semua row lama ke bentuk hash secara eksplisit — aman dijalankan berkali-kali,
  jalankan SEKALI setelah deploy backend versi ini (fallback transisi tetap ada buat jaga-jaga
  kalau belum sempat dijalankan, tapi sebaiknya jangan diandalkan permanen).
- **REGRESSION TEST**: `tests/api-key-hashing.test.js` — key baru tersimpan sebagai hash (bukan
  plaintext), key baru tetap bisa auth `/v1/chat`, key acak tetap ditolak, DAN key lama (plaintext,
  belum dimigrasi) tetap bisa auth lewat fallback + tetap muncul di listing dengan preview yang
  benar. **Sama seperti seluruh test lain di audit lanjutan ini**: sintaks tervalidasi
  (`node --check`) dan dikonfirmasi gagal tepat di titik yang sama (`Cannot find module 'express'`)
  karena keterbatasan lingkungan (lihat AUDIT SUMMARY) — BELUM PERNAH benar-benar PASS di sini.
  Jalankan `npm install && npm test` sebelum deploy.

## MEDIUM-4: `POST /api/keys` gak punya rate limit LAJU pembuatan (beda dari limit jumlah aktif)

- **SEVERITY**: MEDIUM
- **FILE**: `src/routes/keys.routes.js` (sebelum fix)
- **ROOT CAUSE**: `env.apiKeyLimitPerOwner` (dibahas di HIGH-2 lama) cuma membatasi berapa key
  AKTIF yang boleh dimiliki 1 identitas owner yang SAMA — gak ada apa pun yang membatasi LAJU
  percobaan `POST /api/keys` kalau tiap percobaan ngaku sebagai owner/`createdBy` yang BEDA
  (device-id anonim acak, gampang di-generate ulang tiap kali). Ini persis pola yang sama
  seperti HIGH-4 (`/api/chat`) tapi buat endpoint ini masih belum ketutup.
- **IMPACT**: Bisa dipakai buat spam banyak row `api_keys` (storage bloat) atau — kalau
  percobaan disertai Bearer token acak/curian — buat ngebanjirin endpoint verifikasi Supabase
  Auth (`GET /auth/v1/user`) dengan traffic tinggi lewat backend ini sebagai perantara.
- **FIX**: `createKeyLimiter` baru (mirip pola `redeemLimiter`), keyed IP+device-id, 10/menit,
  dipasang khusus di `POST /api/keys` (bukan GET/DELETE, yang risikonya lebih rendah).
- **REGRESSION TEST**: `tests/rate-limit-create-key.test.js`. Sintaks tervalidasi, gagal di
  titik `Cannot find module 'express'` yang sama seperti semua test lain di lingkungan ini
  (lihat AUDIT SUMMARY) — belum PASS beneran, jalankan `npm test` setelah `npm install`.

## MEDIUM-1: Redeem & API-key error tidak punya request ID buat korelasi log

- **SEVERITY**: MEDIUM
- **FIX**: `X-Request-Id` di semua response (generate kalau client gak kirim), ikut di semua
  baris log & body error JSON (field `requestId`, di redeem sebagai field terpisah biar kontrak
  `error` tetap string apa adanya). Lihat `src/app.js`, `src/middleware/error-handler.js`,
  `src/utils/http-chat-relay.js`, `src/controllers/redeem.controller.js`.
- **REGRESSION TEST**: `tests/health.test.js`, `tests/chat.test.js`, `tests/redeem.test.js`.

## MEDIUM-2: Alias `oxy-vision` mengarah ke model yang sebetulnya bukan vision — RESOLVED (bagian backend/katalog API key)

- **SEVERITY**: MEDIUM (CONTRACT MISMATCH)
- **STATUS**: Sempat dipertahankan apa adanya (lihat versi lama entri ini di bawah) sampai ada
  keputusan produk. Sekarang SUDAH ada keputusan: alihkan ke model yang sama dipakai
  `oxy-thinking`. Diimplementasikan.
- **FIX**: `src/config/models.js` — `API_KEY_MODEL_ALIASES['oxy-vision']` diubah dari
  `'openai/gpt-oss-20b'` (text-only) jadi `'qwen/qwen3.6-27b'` (satu-satunya `VISION_MODELS`).
  Resolusi alias terjadi PER-REQUEST di `public.controller.js` (bukan disimpan di row key saat
  dibuat), jadi API key `oxy-vision` yang SUDAH ADA sebelumnya otomatis ikut kepakein model yang
  benar di request berikutnya — TIDAK perlu migrasi data apa pun.
- **REGRESSION TEST**: `tests/oxy-vision-alias.test.js` — cek `API_KEY_MODEL_ALIASES['oxy-vision']`
  emang ada di `VISION_MODELS`, dan API key baru dengan `modelId:'oxy-vision'` gak lagi ditolak
  `MODEL_NOT_VISION_CAPABLE` pas ngirim gambar lewat `/v1/chat`.
- **UPDATE — SEKARANG SUDAH DIBERESKAN JUGA**: dropdown model di CHAT UTAMA
  (`chat/js/01-config-provider.js`) tadinya punya entri sendiri berlabel "Oxy Vision" yang
  **independen** dari alias katalog API key di atas, dan entri itu menunjuk ke
  `openai/gpt-oss-20b` (sama-sama bukan `VISION_MODEL`). Dikonfirmasi lagi kalau nyamain
  value-nya ke `qwen/qwen3.6-27b` TANPA perubahan lain bakal bikin 2 entri di array `MODELS`
  ber-`value` IDENTIK — dan setidaknya 5 tempat (`02-state-session.js`, `03-ui-interactions.js`
  x2, `04-account-settings.js`, `07-history-messages.js`) melakukan
  `getAllModels().find(m => m.value === X)`, yang cuma bakal nemu entri PERTAMA yang cocok — jadi
  bukan cuma "kelihatan aktif bersamaan" doang, tapi bisa salah nampilin label/warna/deskripsi
  model yang lagi dipakai. Solusinya BUKAN duplikasi value, tapi MENGGABUNGKAN jadi 1 entri:
  entri lama "Oxy Thinking" (`value:'qwen/qwen3.6-27b'`) di-rename jadi **"Oxy Vision"** (pakai
  ikon mata yang tadinya punya entri lama), deskripsinya di `02-state-session.js` diubah jadi
  "Reasoning · Deep + Vision" (biar kemampuan reasoning-nya tetap kelihatan), dan entri
  `openai/gpt-oss-20b` yang lama dihapus total (termasuk dari `OTHER_MODEL_VALUES` dan
  `MODEL_COLORS`/`MODEL_SUBS`/`MODEL_CODE` biar gak ada data yatim yang membingungkan). User yang
  sebelumnya kesimpen preferensi "Oxy Thinking" (value sama) tetap jalan normal, cuma sekarang
  lihat nama "Oxy Vision"; user yang preferensinya kesimpen ke entri lama yang dihapus akan jatuh
  balik otomatis ke model default paling atas (`selectedModel = MODELS[0].items[0]`, jalur
  fallback yang MEMANG SUDAH ADA dari awal, dicek gak crash). `openai/gpt-oss-20b` sendiri TETAP
  ada & valid di `ALL_KNOWN_MODELS` backend (gak dihapus dari daftar provider), cuma sekarang gak
  ada jalur (dropdown ATAU alias publik) yang menunjuk ke situ lagi.

## MEDIUM-2 (versi lama, buat rekam jejak) — sebelum keputusan produk di atas

- **STATUS lama**: Sudah ditemukan & didokumentasikan di audit rekonstruksi awal (lihat `README.md`
  bagian "Provider & model mapping"). Dikonfirmasi ULANG di audit ini: `qwen/qwen3.6-27b` adalah
  SATU-SATUNYA `VISION_MODEL` di frontend (`01-config-provider.js`), berlabel **"Oxy Thinking"**
  di dropdown, sementara alias katalog API key `oxy-vision` justru menunjuk ke
  `openai/gpt-oss-20b` (model teks biasa). Ini konsisten di 3 sumber independen (2 file frontend +
  MASTER PROMPT asli), jadi dipertahankan APA ADANYA (tidak "diperbaiki" sepihak) sesuai instruksi
  eksplisit MASTER PROMPT: **"Jangan otomatis mengubah mapping... Jangan mengubah API contract
  tanpa alasan."** Kalau ini memang mau diluruskan, itu keputusan produk yang perlu dikonfirmasi
  dulu (bisa berarti mengubah HTML dropdown model + katalog alias sekaligus, karena keduanya
  saling bergantung).
- **REKOMENDASI lama**: butuh keputusan produk, bukan keputusan teknis unilateral. (Sudah
  ditindaklanjuti untuk bagian alias API key — lihat entri di atas.)

## MEDIUM-3: `X-Device-Id` tidak divalidasi bentuknya

- **SEVERITY**: MEDIUM
- **FIX**: `src/controllers/redeem.controller.js` — device id di luar rentang wajar (kosong,
  >200 karakter) diabaikan (dianggap gak ada device id) alih-alih dipakai apa adanya ke storage.
- **REGRESSION TEST**: `tests/redeem.test.js`.

## LOW-1: `X-Powered-By: Express` bocor secara default

- **FIX**: sudah `app.disable('x-powered-by')` sejak versi awal, dikonfirmasi ulang lewat test.

## LOW-2: Belum ada automated test suite yang ikut dikirim

- **FIX**: `tests/` (9+ file, `node:test` bawaan — tanpa dependency tambahan), `npm test`.

---

## Yang SUDAH diaudit dan dikonfirmasi TIDAK bermasalah (supaya gak diklaim asal aman)

- **Credit double-charge**: dikonfirmasi backend ini gak pernah manggil RPC Supabase
  (`deduct_credit` dkk) sama sekali — nolnya kemungkinan double-charge dari sisi backend, karena
  emang gak ada logic kredit di backend ini sama sekali (100% di Supabase, sesuai desain awal).
- **CORS**: sudah configurable lewat `CORS_ORIGINS`, default `*` didokumentasikan trade-off-nya
  (aman karena gak ada endpoint berbasis cookie/credential di backend ini).
- **Body size limit**: configurable (`MAX_BODY_BYTES`), gak hardcode kekecilan (vision) atau
  kegedean.
- **Provider secrets**: seluruhnya dari environment variable, gak ada yang hardcoded — dikonfirmasi
  lewat pemeriksaan seluruh `src/providers/*.js`.
- **Timeout**: `UPSTREAM_TIMEOUT_MS` diterapkan ke request awal (headers), SENGAJA tidak memotong
  stream yang udah jalan (biar respons AI panjang gak keputus tengah jalan) — didokumentasikan
  jelas di `src/providers/base.js`.
- **SSE abort**: `res.on('close')` (BUKAN `req.on('close')` — lihat catatan teknis penting di
  `src/utils/http-chat-relay.js`, ini bug nyata yang ditemukan & diperbaiki di audit REKONSTRUKSI
  awal, dikonfirmasi ulang di audit ini masih benar) — dites beneran dengan abort HTTP asli, bukan
  simulasi.
- **Plan enforcement (limit pesan per plan)**: dikonfirmasi ini logic FRONTEND murni
  (`MSG_LIMIT_WINDOW_MS` di `01-config-provider.js`), backend cuma nambahin proteksi abuse
  infrastruktur terpisah (rate limit) — sesuai pembedaan eksplisit MASTER PROMPT antara "product
  limit" vs "infrastructure abuse protection".

## Yang BELUM/TIDAK BISA diverifikasi penuh dari lingkungan pembuatan ini (jujur, bukan diklaim PASS)

- **Verifikasi Supabase Auth terhadap project ASLI**: dites lewat server tiruan yang niru endpoint
  `GET /auth/v1/user`, BUKAN terhadap project Supabase asli (lingkungan pembuatan ini gak ada
  akses internet keluar). Perilaku endpoint resminya sudah dikonfirmasi lewat dokumentasi Supabase
  (bentuk request/response `/auth/v1/user`), tapi tetap **wajib dites ulang pakai token sesi asli**
  sebelum dianggap production-ready (lihat "Final Verification" di README).
- **Semua provider AI asli** (Groq/NVIDIA/Mistral/Perplexity/OpenRouter/Gemini): sama seperti audit
  rekonstruksi awal — dites lewat server tiruan, bukan API asli. Tidak berubah dari audit
  sebelumnya, disebut ulang di sini biar gak terlewat pas checklist akhir.
- **`npm audit`**: tidak bisa dijalankan (npm registry gak bisa diakses dari lingkungan pembuatan
  ini). Jalankan `npm audit` sendiri setelah `npm install` di mesin yang punya akses internet,
  sebelum deploy production.
