# CHANGELOG-HARDENING — Putaran 2 (audit lanjutan MASTER PROMPT V3)

Lanjutan dari `CHANGELOG-HARDENING.md` (putaran 1, backend-only). Putaran ini mencakup
**Supabase** (di luar repo backend) sekaligus backend Node dan frontend. Detail teknis penuh
tiap temuan ada di `SECURITY-AUDIT.md` (CRITICAL-3, HIGH-4, HIGH-5, MEDIUM-4) — file ini
ringkasan yang bisa dipakai buat deploy & compatibility check.

## 1. Apa yang berubah

| Area | Perubahan | File |
|---|---|---|
| Supabase RPC | `set_user_plan` dikunci ke plan gratis saja; `deduct_credit` menolak amount ≤0 | `fix-critical-plan-credit-rpc.sql` |
| Supabase RPC | RPC baru `admin_grant_plan`, service_role-only | `phase2-admin-grant-plan-rpc.sql` |
| Backend | Redeem plan sekarang butuh login + manggil Supabase lewat service_role | `redeem.service.js`, `redeem.controller.js`, `redeem.routes.js`, `supabase-admin.service.js` (baru) |
| Backend | `/api/chat` gak lagi bisa dilewatin dengan gonta-ganti X-Device-Id | `chat.routes.js` |
| Backend | API key disimpan sebagai hash, bukan plaintext | `api-key.service.js`, `apikey.repo.js`, `utils/id.js` |
| Backend | `POST /api/keys` sekarang punya rate limit laju (bukan cuma limit jumlah aktif) | `keys.routes.js` |
| Backend | CLI admin baru: `retry-grant` (pulihkan redeem yang gagal grant) | `scripts/admin.js` |
| Backend | Script migrasi baru: `migrate-api-key-hashes.js` (key lama -> hash) | `scripts/migrate-api-key-hashes.js` |
| Frontend | Redeem sekarang kirim token sesi; gak manggil `sbSetUserPlan()` lagi buat hasil redeem plan | `chat/js/04-account-settings.js` |

## 2. Breaking change yang perlu diketahui

**Redeem kode tipe "plan" (pro/maks/promax) sekarang WAJIB login.** Sebelumnya jalan tanpa
sesi Supabase sama sekali (dan justru itu bagian dari lubang keamanannya — lihat CRITICAL-3).
Kode tipe `unlock_model` dan generic TIDAK terpengaruh, tetap jalan tanpa login seperti biasa.
Frontend yang disertakan di sini sudah disesuaikan (`04-account-settings.js`); kalau ada
frontend/klien lain yang juga memanggil `/api/redeem` langsung, itu perlu update yang sama:
kirim `Authorization: Bearer <access_token>` saat redeem kode plan.

Semua endpoint & response shape LAIN tidak berubah — termasuk `POST /api/keys` (`{key: "oxy_..."}`)
dan `/api/redeem` (`{success, type, plan, permanent}` / `{success, type, unlockModel, hours}`)
tetap persis sama dari sudut pandang caller yang sudah login sebagaimana mestinya.

## 3. Urutan deploy (PENTING, ikuti urutan ini)

1. **Supabase SQL Editor**: jalankan `fix-critical-plan-credit-rpc.sql`, lalu
   `phase2-admin-grant-plan-rpc.sql`. Verifikasi lewat query di komentar akhir file kedua
   (pastikan cuma `service_role` yang punya EXECUTE di `admin_grant_plan`).
2. **Supabase Dashboard**: ambil `service_role` secret key (Project Settings > API).
3. **Backend `.env`**: isi `SUPABASE_SERVICE_ROLE_KEY` dengan key dari langkah 2. Cek
   `.env.example` buat variabel baru lainnya (`CHAT_RATE_LIMIT_PER_IP`).
4. **Deploy backend baru** (kode di `OxyChat-Backend-checkpoint.zip`).
5. **Sekali, setelah backend baru jalan**: `node scripts/migrate-api-key-hashes.js` — konversi
   API key lama ke bentuk hash. Aman ditunda beberapa saat (ada fallback transisi, lihat
   HIGH-5) tapi sebaiknya jangan lama-lama.
6. **Deploy frontend baru** (`OxyChat-Frontend-checkpoint.zip`) — kirim token sesi saat redeem.
7. `npm install && npm test` di mesin dengan akses internet — SEMUA temuan di putaran ini
   ditulis testnya, tapi belum pernah benar-benar dieksekusi (lingkungan audit ini gak ada akses
   npm registry). Ini langkah verifikasi yang belum dilakukan, bukan opsional.

## 4. Keputusan produk yang masih menunggu (bukan bug, gak di-otak-atik sepihak)

- **MEDIUM-2 (dari putaran 1)**: alias `oxy-vision` di dropdown model routing ke model
  text-only (`openai/gpt-oss-20b`), bukan model vision beneran. Belum diubah karena butuh
  keputusan: model vision mana yang dimaksud (lihat catatan `qwen/qwen3.6-27b` yang dipakai
  `oxy-thinking` — mungkin itu yang seharusnya dipakai `oxy-vision`, tapi ini tebakan, bukan
  fakta dari kode).
- **Pembayaran asli**: begitu payment gateway beneran diintegrasikan, `admin_grant_plan` yang
  sama bisa dipanggil dari flow pembayaran (bukan cuma redeem) — arsitekturnya sudah siap buat
  itu, cuma pemicunya yang perlu ditambah nanti.

## 5. Database & persistence — ditinjau, gak ada perubahan (section 8 master prompt)

- **Duplicate redeem code**: sudah ada guard-nya dari awal (`create-code` di `scripts/admin.js`
  cek `findByCode` dulu sebelum insert) — dicek ulang, memang aman, gak perlu tambahan.
- **Index SQL yang dideklarasikan (`CREATE INDEX ...`) sebenarnya gak dipakai query manapun** —
  `findAll`/`findOne` di `db/database.js` selalu `SELECT data FROM table` (full scan) lalu
  filter di JS, gak pernah pakai `WHERE kolom_terindeks = ?`. Index-nya jadi murni kosmetik saat
  ini. Bukan masalah nyata di skala project ini (jumlah row kecil), jadi TIDAK diubah — cuma
  dicatat biar jelas kalau nanti mikirin performa di skala lebih besar, refactor `collection()`
  buat beneran pakai `WHERE` yang perlu disentuh, bukan cuma nambah index lagi.
- **Foreign key**: memang gak ada constraint FK sama sekali (desainnya emang bukan relasional) —
  integritas referensial (mis. `redeem_redemptions.userId` merujuk ke user Supabase) dijaga di
  level aplikasi, bukan constraint database. Konsisten dengan gaya proyek ini, gak diubah.
- **JSON fallback**: keterbatasannya (`persist()` nulis ulang seluruh file tiap mutasi, cuma
  aman 1 proses) sudah didokumentasikan jujur di komentar `database.js` sejak awal — dikonfirmasi
  ulang, bukan klaim berlebihan.

## 6. Yang belum diverifikasi (jujur, bukan diklaim beres)

Sama seperti seluruh putaran ini: setiap fix di atas diverifikasi lewat pembacaan kode manual +
`node --check` (sintaks), BUKAN eksekusi `npm test` beneran (lingkungan audit lanjutan ini gak
ada akses `npm install`). Jalankan test suite penuh sebelum production. Live Supabase Auth,
live provider AI, dan live `admin_grant_plan` lewat service_role key sungguhan juga belum pernah
dicoba ke project Supabase asli — cuma lewat mock di test harness.
