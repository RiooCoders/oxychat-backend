# Catatan Perbaikan VaeltrixAI — 30 Sep 2026

Dokumen ini ada di zip Frontend dan Backend (isinya sama).

## Urutan deploy (WAJIB berurutan)

1. **Supabase** → SQL Editor → paste semua isi `FIX-CREDITS-AND-RPC.sql` → Run. (Aman diulang, data user gak dihapus.)
2. **Backend (Railway)** → deploy folder `backend`. Cek env di Railway:
   - `OPENROUTER_MODEL`: kalau isinya `openrouter/auto`, **hapus atau ganti `openrouter/free`** (auto = berbayar, 402 kalau saldo kosong).
   - `MODEL_OVERRIDES=qwen/qwen3.6-27b` formatnya salah (selalu diabaikan). Hapus, atau pakai JSON: `{"qwen/qwen3.6-27b":"qwen/qwen3.8-27b"}` (sekarang udah default).
3. **Frontend (Vercel)** → deploy folder `frontend`. `version.json` udah dinaikkan, jadi PWA yang keinstall bakal narik file baru.

## 4 masalah: akar penyebab → perbaikan

### 1) Thinking bocor
Penyebab:
- Filter lama nyaring **per potongan stream**. Padahal tag kepecah (`<` + `think` + `>` = 3 potongan) dan isi thinking ngalir di potongan berikutnya yang gak punya tag → tembus ke layar. Kasus di screenshot (`<think<|message|>…`) persis ini.
- Non-stream: tag yang gak ketutup menghapus SELURUH jawaban.
- Frontend ngirim `reasoning_format:"parsed"` ke semua model Groq, padahal gpt-oss gak support. Dan model yang punya reasoning bawaan tetap dipaksa nulis `<think>` lewat prompt (bikin format rusak).
- Riwayat chat yang dikirim balik ke AI masih bawa blok `<think>` lama → model niru → bocor lagi.

Perbaikan:
- `backend/src/utils/sanitize-content.js` (ThinkingFilter stateful) + `sse-think-filter.js` (dipasang di relay). Ngerti: `<think|thinking|thought|reasoning|reason>`, varian rusak `<think<|message|>`, token Harmony (`<|channel|>analysis…final`), `analysis…assistantfinal`, token spesial nyasar (`<|im_end|>`). Tag di dalam blok kode (```) **gak** disentuh.
- `utils/reasoning.js`: parameter thinking diterjemahin per model (gpt-oss: `reasoning_effort`+`include_reasoning`; Qwen: `reasoning_format`/`effort`). Frontend cuma kirim `show_thinking` + `reasoning_effort`.
- Thinking ON → lewat field `reasoning_content` → masuk pill "Berpikir". Thinking OFF → dibuang total di server.
- Frontend punya salinan filter yang sama (`js/00b-think-filter.js`) sebagai lapis kedua, dipakai di stream, `stripThinkBlocks`, dan `renderMDFull` (pesan lama yang kadung bocor sekarang dirender rapi). Kalau logika filter diubah, ubah di DUA tempat.
- `buildApiHistory()`: riwayat dikirim bersih (tanpa `<think>`, tanpa field internal) dan dibatasi 30 pesan / 16.000 karakter (pesan terakhir selalu ikut). Angkanya di `js/05-thinking-effort.js`.

### 2) Preview/artifact layar hitam
Penyebab (ketemu lewat reproduksi di Chromium): `index.html` baris menu "Preview" punya `<b>Preview</span>` — **tag `<b>` gak ketutup**. Browser nyelipin `#modal-body` ke dalam `<b>` itu, tingginya jadi **0px**, jadi iframe preview (dan tab Kode) gak kelihatan. Bukan salah kode game dari AI.

Perbaikan:
- `<b>` ditutup. Tab Kode & Preview sekarang ngisi layar penuh.
- Iframe preview di-sandbox **tanpa `allow-same-origin`** (kode dari AI gak boleh baca localStorage/sesi akun lo), plus `allow-pointer-lock`, `allow-downloads`, fullscreen (buat game FPS). localStorage di dalam preview diganti penyimpanan memori biar skor/save gak bikin crash.
- Error JS & script CDN yang gagal dimuat sekarang tampil di layar (kotak merah "Error di kode"), bukan layar kosong.
- Bug ikutan: getter `scrollTop` di `index.html` rekursif (`return this.scrollTop`) → "Maximum call stack size exceeded" tiap scroll, bikin tombol scroll-ke-bawah & auto-scroll kacau. Udah diperbaiki.

### 3) Kredit gak turun + rate limit
Penyebab kredit: fungsi `deduct_credit` di Supabase **selalu error** ("column reference credit_awal_sisa is ambiguous") karena nama kolom output nabrak nama kolom tabel. RPC gagal → frontend diem-diem tetap ngizinin → kredit stuck di 510. Selain itu mode Multi & Gambar gak pernah motong kredit sama sekali, dan error provider tetap makan jatah pesan.

Perbaikan (`FIX-CREDITS-AND-RPC.sql` + frontend):
- `charge_chat()` (atomic): refill harian, reset jendela 5 jam, tolak kalau jatah pesan habis / kredit 0, potong kredit (harian dulu, baru awal), hitung pesan. `chat_quota()` buat sinkron saat login. `deduct_credit` lama dibenerin juga (buat klien lama).
- **Rate limit 5 jam disimpen di server** (kolom `msg_window_start`, `msg_count`) — gak bisa di-reset lewat clear data. Limit per paket: Newbie 10, Pro 100, Max 300, Pro Max 450 per 5 jam.
- **Biaya per chat dihitung di server** (fungsi `chat_credit_cost`, angkanya gampang diubah di SQL): tarif model (ringan 4 / standar 8 / berat 12 / deep research 18) + thinking (rendah +1, sedang +2, tinggi +4, maks +6) + panjang jawaban (+1 per 250 huruf, maks +8); min 1, maks 30. Multi chat: 6 per model yang berhasil jawab. Gambar: 10.
  > Gue artiin "sesuai temperatur" = sesuai beban tiap chat (model + thinking effort + panjang jawaban). Kalau maksudnya beda, tinggal ubah `chat_credit_cost`.
- Badge kredit langsung update + animasi "-N". Tap badge nampilin sisa pesan & waktu reset.
- Error provider / stop sebelum ada jawaban / balasan kosong = **gratis** (jatah pesan dibalikin).
- Celah ditutup: browser gak bisa lagi `UPDATE` kolom plan/kredit langsung (trigger `protect_profile_columns`), dan `set_user_plan` gak lagi percaya angka kredit dari client. Paket berbayar cuma lewat redeem code.
- Kalau SQL belum dijalanin, app gak crash: muncul toast "jalankan FIX-CREDITS-AND-RPC.sql".
- Kalau sinkron profil gagal (toast "Sinkron akun belum sempurna"), user tetap boleh chat — gak diblok gara-gara kredit 0 palsu di layar.

### 4) "Provider openrouter sedang tidak tersedia" padahal pakai Groq
Penyebab: kalau model Groq gagal (limit token/menit Groq free cuma ~8rb → 413, rate limit, dll), server **otomatis lompat ke OpenRouter `openrouter/auto`** (router berbayar, 402 kalau saldo kosong). Error OpenRouter-nya **menimpa** error asli, jadi lo liat "openrouter" padahal masalahnya di Groq. Kadang OpenRouter nyala dan ngejawab lewat model yang format thinking-nya rusak (itu asal bocor di screenshot).

Perbaikan (`services/chat.service.js`, `providers/base.js`, `config/models.js`):
- Urutan percobaan: model utama → **model "saudara" di Groq** (kuota Groq dihitung per model) → OpenRouter `free`.
- Error yang ditampilin = error **provider utama** (+ catatan kalau cadangan juga gagal), bukan error cadangan.
- Klasifikasi error baru: 402 (saldo), 413 (kepanjangan), 429 (+ waktu tunggu), `decommissioned/deprecated`. Request yang emang salah (400) gak di-fallback. Timeout lokal gak di-fallback berlapis (biar gak nunggu berkali-kali).
- `qwen/qwen3.6-27b` (Vision) di-remap ke `qwen/qwen3.8-27b` (Groq men-deprecate 3.6). Id di frontend gak berubah.
- Default `OPENROUTER_MODEL` jadi `openrouter/free`.

## Bug lain yang ketemu & diperbaiki
- Mode **Multi Chat** error terus: manggil `callVaeltrixChatAPI` yang gak ada (sisa rename callVaeltrixChatAPI) → jadi `callVaeltrixAPI`.
- `activeDraftFlush` di mode gambar bisa error "Cannot access 'full' before initialization".
- `backend/src/server.js` baris 1 di zip lo tertulis `''''use strict';` (4 kutip) → **SyntaxError, backend gak bisa start** kalau di-deploy dari zip itu. Udah dibenerin jadi `'use strict';`.

## Hasil tes
Dijalanin di sandbox:
- Backend: 27 tes lolos (`node --test tests/think-filter.test.js tests/chat-fallback.test.js`): filter thinking (termasuk stream dipotong acak di mana pun, kode game lewat byte-identik), urutan fallback, pesan error, terjemahan param reasoning, relay SSE end-to-end (non-stream, stream, error). Filter backend vs salinan frontend dites diferensial: 600 kombinasi potongan, hasilnya identik.
- Frontend di Chromium: 7 cek preview + 17 cek alur kirim pesan (kredit turun, limit 5 jam, error = gratis, thinking ON/OFF termasuk model tanpa reasoning bawaan, ujung stream, multi, gambar, SQL belum dijalanin, profil darurat) — semua lolos.

**Belum bisa dites di sandbox (cek sendiri setelah deploy):**
- `FIX-CREDITS-AND-RPC.sql` **belum dijalanin di Postgres/Supabase asli** (sandbox gak punya Postgres). Logika di-port ke simulasi JS buat tes alur client; SQL-nya sendiri sudah diperiksa manual. Kalau ada error pas Run, kirim pesan error-nya ke gue.
- Tes lama backend yang butuh `express` (`chat.test.js`, `security.test.js`, dll) gak bisa dijalanin (gak ada node_modules). Gue update 2 asersinya biar cocok sama alur fallback baru; jalanin `npm install && npm test` sekali di lokal.
- Three.js asli dari CDN & GPU beneran gak diuji (sandbox offline). Yang diuji: layout, canvas 2D, sandbox, dan pesan error CDN.

Tes cepat sesudah deploy: login → kirim 1 chat → badge kredit harus turun & muncul "-N" → di Supabase tabel `profiles` kolom `msg_count` naik 1.
