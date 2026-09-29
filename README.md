# VaeltrixAI Backend (rekonstruksi)

Backend hasil reverse-engineering dari frontend **VaeltrixAI** (folder `chat/` beserta
`CreateApikey/` dan `Request-Update/`). Backend asli project ini hilang; source code di sini
dibangun ulang murni dari kontrak yang benar-benar dipanggil frontend (lihat bagian **Laporan
Audit** di bawah), bukan tebakan/fitur karangan.

Backend ini adalah **AI gateway**: menerima request dari frontend, merutekannya ke provider AI
yang sesuai (Groq/NVIDIA/Mistral/Perplexity/OpenRouter/Gemini) pakai API key yang disimpan di
server, lalu menormalisasi hasilnya jadi format OpenAI-compatible yang dimengerti frontend.
Auth user, profile, kredit, dan riwayat chat **tetap** ditangani Supabase langsung dari frontend
(lihat `chat/js/00-supabase.js`) — backend ini tidak menduplikasi itu, tapi SEKARANG ikut
memverifikasi sesi Supabase itu buat ownership API key (lihat `CHANGELOG-HARDENING.md`).

> **Sudah melalui 1 putaran audit hardening keamanan** (auth/ownership, rate limit, race
> condition, dst). Baca `SECURITY-AUDIT.md` (temuan detail per severity) dan
> `CHANGELOG-HARDENING.md` (ringkasan + perubahan kontrak & migrasi frontend) sebelum deploy.

## Menjalankan

```bash
npm install
cp .env.example .env
# isi minimal 1 provider API key di .env (GROQ_API_KEY dst)
npm start
```

Jalankan test (opsional tapi disarankan, 79 test, gak butuh API key asli — semua provider
disimulasikan): `npm test`.

Server baca `PORT` dari environment (default 3000 kalau tidak diset). Sama persis di lokal,
Termux (`pkg install nodejs && npm install && npm start`), VPS, Railway, Render, maupun Fly.io —
tidak butuh Docker/systemd/GPU untuk jalan.

Arahkan `SERVER_URL` di `chat/js/01-config-provider.js` (dan `VaeltrixAI_server_url_v1` yang
tersimpan di localStorage) ke URL server ini. **Deploy juga `chat/CreateApikey/index.html` dan
`chat/CreateApikey/script.js` versi terbaru** — keduanya diubah sedikit di putaran hardening ini
(lihat `CHANGELOG-HARDENING.md`) supaya ownership API key beneran aman.

## Environment variables

Lihat `.env.example` untuk daftar lengkap + penjelasan tiap variabel. Ringkasnya:

- `PORT`, `CORS_ORIGINS` — konfigurasi server dasar.
- `GROQ_API_KEY`, `NVIDIA_API_KEY`, `MISTRAL_API_KEY`, `PERPLEXITY_API_KEY`,
  `OPENROUTER_API_KEY`, `GEMINI_API_KEY` — credential provider. Boleh dikosongkan salah satu;
  provider itu otomatis dianggap unavailable dan server tetap jalan selama ≥1 provider aktif.
- `MISTRAL_MODEL`, `OPENROUTER_MODEL`, `GEMINI_MODEL`, `SPECTRAX_FALLBACK_MODEL`,
  `MODEL_OVERRIDES` — model ASLI yang dipanggil di upstream (alias publik ke frontend tidak
  berubah). Lihat "Provider & model mapping" di bawah.
- `ADMIN_TOKEN` — dipakai CLI `npm run admin`, bukan endpoint HTTP.
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` — verifikasi sesi login (buat ownership API key). Default
  sudah cocok sama project yang dipakai frontend, biasanya gak perlu diubah.
- `API_KEY_LIMIT_PER_OWNER`, `CHAT_RATE_LIMIT_PER_MIN`, `V1_CHAT_RATE_LIMIT_PER_KEY`,
  `V1_CHAT_RATE_LIMIT_PER_IP` — limit & rate limit (lihat `CHANGELOG-HARDENING.md`).
- `DATABASE_PATH` — lokasi file storage (lihat "Storage").

## Struktur folder

```
backend/
├── src/
│   ├── server.js            entry point (listen, graceful shutdown, startup check)
│   ├── app.js                rakitan Express (middleware + routing)
│   ├── routes/                POST/GET/DELETE per endpoint -> controller
│   ├── controllers/           HTTP plumbing (parse req, kirim res, relay SSE)
│   ├── services/               business logic (validasi, orkestrasi provider, redeem, api-key,
│   │                              supabase-auth.service.js buat verifikasi sesi login)
│   ├── providers/               1 file per provider AI (Groq/NVIDIA/Mistral/Perplexity/OpenRouter/Gemini)
│   ├── middleware/              cors, rate-limit, error-handler, api-key-auth,
│   │                              optional-supabase-auth, security-headers
│   ├── db/                       storage (SQLite bawaan Node / fallback JSON) + repositories +
│   │                                dukungan transaksi (database.js: transaction())
│   ├── config/                    env.js, models.js (registry model/provider terpusat)
│   └── utils/                      errors, logger (auto-redact secret), validation, id, sse relay
├── scripts/admin.js            CLI internal (kelola redeem code & promo featured)
├── tests/                       automated test (node:test bawaan, `npm test`, 79 test)
├── data/                          file database (di-gitignore)
├── CHANGELOG-HARDENING.md        ringkasan perbaikan keamanan + migrasi kontrak frontend
└── SECURITY-AUDIT.md             detail tiap temuan (severity/root cause/impact/fix/test)
```

## Dokumentasi API

Semua error (kecuali `/api/redeem`, lihat catatan di bawah) berbentuk:
`{ "error": { "message": "...", "code": "..." } }`.

### `GET /`
Health check. Dipanggil frontend tiap 30 detik buat nampilkan/nyembunyiin banner "server down".

```bash
curl http://localhost:3000/
# {"status":"ok","service":"VaeltrixAI API"}
```

### `POST /api/chat`
Endpoint utama. Dipanggil frontend (`callVaeltrixAPI`) untuk chat normal, Multi Chat (paralel per
model, `stream:false`), auto-title percakapan (`model:"llama-3.1-8b-instant"`), dan deskripsi
gambar (`model:"qwen/qwen3.6-27b"`, satu-satunya model vision — lihat catatan di bagian audit).

Headers: `Content-Type: application/json`, `X-Device-Id: <id>`.

Body:
```json
{
  "provider": "groq",
  "model": "llama-3.1-8b-instant",
  "messages": [{"role":"user","content":"Halo"}],
  "stream": true,
  "temperature": 1.0,
  "reasoning_effort": "medium",
  "reasoning_format": "parsed"
}
```
`provider` dari client diabaikan untuk keamanan — server selalu menghitung ulang provider yang
benar dari `model` (registry di `src/config/models.js`), supaya kombinasi model+provider yang
tidak cocok tidak bisa diselundupkan. `reasoning_effort`/`reasoning_format` hanya diteruskan ke
upstream kalau modelnya jatuh ke provider Groq (sesuai frontend, `getReasoningExtraParams()`).

Non-stream response — OpenAI-compatible:
```json
{
  "id": "chatcmpl-...", "object": "chat.completion", "created": 0,
  "choices": [{"index":0,"message":{"role":"assistant","content":"..."},"finish_reason":"stop"}],
  "usage": {"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}
}
```

Stream response — SSE (`Content-Type: text/event-stream`), relay langsung dari provider:
```
data: {"choices":[{"delta":{"content":"Ha"}}]}

data: {"choices":[{"delta":{"content":"lo"}}]}

data: [DONE]
```

Error: status non-2xx, body `{"error":{"message":"...","code":"..."}}`.

```bash
curl http://localhost:3000/api/chat \
  -H "Content-Type: application/json" -H "X-Device-Id: test-device" \
  -d '{"provider":"groq","model":"llama-3.1-8b-instant","messages":[{"role":"user","content":"Halo"}],"stream":false}'
```

### `POST /api/redeem`
Headers: `Content-Type: application/json`, `X-Device-Id: <id>`. Body: `{"code":"KODE"}`.

Sukses: `{"success":true,"type":"unlock_model","unlockModel":"spectrax","hours":24}` atau
`{"success":true,"type":"plan","plan":"pro","permanent":true}` atau `{"success":true}`.

**Gagal (kontrak khusus, beda dari endpoint lain):** status non-2xx, body
`{"error":"Kode gak valid atau udah gak berlaku"}` — `error` di sini STRING langsung, bukan
object, karena frontend baca `data.error` apa adanya (`submitRedeemCode()` di
`chat/js/04-account-settings.js`).

### `GET /api/promo-featured`
Tidak butuh auth. `{"code":"KODE"}` kalau ada promo aktif, `{}` kalau tidak ada. Dikelola lewat
`npm run admin -- feature-code --code=...` (lihat bawah), bukan endpoint admin publik.

### `POST /api/keys`
Body: `{"name":"Nama Key","modelId":"auto-model","createdBy":"owner-id"}`. `modelId` harus salah
satu dari katalog alias publik (lihat "Provider & model mapping").

**Ownership** (diperketat di putaran hardening — lihat `CHANGELOG-HARDENING.md`): kalau request
menyertakan header `Authorization: Bearer <supabase_access_token>` yang valid, identitas
TERVERIFIKASI itu yang jadi pemilik key (`createdBy` di body diabaikan). Kalau tidak ada token
dan `createdBy` **berbentuk email**, request ditolak `401 EMAIL_OWNER_REQUIRES_AUTH` (email cuma
sah kalau didukung sesi login asli). Kalau `createdBy` bukan email (device-id anonim ala
`anon-xxxxx`), tetap diterima apa adanya seperti sebelumnya (jalur trial/anonim).

**Limit**: maksimal `API_KEY_LIMIT_PER_OWNER` (default 1) key AKTIF per identitas owner — lebih
dari itu ditolak `409 API_KEY_LIMIT_REACHED`.

Sukses (`201`): `{"key":"vaeltrix_..."}` — ini **satu-satunya momen** key lengkap ditampilkan. Gagal:
`{"error":{"message":"...","code":"..."}}`.

### `GET /api/keys?createdBy=...`
(atau kirim `Authorization: Bearer <token>`, `createdBy` jadi opsional — aturan ownership sama
seperti di atas). Balikin array langsung (bukan dibungkus `{data:[...]}`):
`[{"id":"...","name":"...","modelId":"...","keyPreview":"vaeltrix_AbCd…WxYz","createdAt":0}, ...]`.
**Key lengkap TIDAK lagi dikirim di sini** (cuma preview termasker) — lihat CRITICAL-2 di
`SECURITY-AUDIT.md`. Kalau butuh key lengkap lagi, harus bikin key baru (gak ada cara "reveal").

### `DELETE /api/keys/:id?createdBy=...`
(atau `Authorization: Bearer <token>`). Hapus cuma kalau identitas cocok sama pemilik key.
`{"success":true}` atau `404` kalau tidak ketemu/bukan pemilik.

### `POST /v1/chat` — API publik pemegang API key
```bash
curl -X POST SERVER_URL/v1/chat \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"halo"}],"stream":false}'
```
Model **selalu** ditentukan oleh `modelId` yang dipilih pas bikin key (client tidak perlu, dan
tidak bisa, override lewat `model` di body). **Rate limit 2 lapis** (baru): per API key
(`V1_CHAT_RATE_LIMIT_PER_KEY`, default 60/menit) dan per IP (`V1_CHAT_RATE_LIMIT_PER_IP`, default
120/menit, berlaku bahkan buat percobaan auth yang gagal) — `429` kalau kelewat.

## CLI Admin (`npm run admin`)

```bash
npm run admin -- create-code --code=PROMO2026 --type=plan --plan=pro --maxUses=100 --expiresInDays=30 --featured
npm run admin -- create-code --type=unlock_model --unlockModel=spectrax --hours=24
npm run admin -- list-codes
npm run admin -- inspect-code --code=PROMO2026
npm run admin -- disable-code --code=PROMO2026
npm run admin -- feature-code --code=PROMO2026
npm run admin -- list-keys --owner=user@example.com
```
Kalau `ADMIN_TOKEN` di `.env` diisi, tiap perintah butuh tambahan `--token=<ADMIN_TOKEN>`.

## Provider & model mapping

Model publik (dikirim frontend apa adanya) → provider (dihitung server, bukan dari client):

| Model publik | Provider | Model asli di upstream |
|---|---|---|
| `llama-3.1-8b-instant`, `llama-3.3-70b-versatile`, `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.6-27b` | groq | sama persis (bisa dioverride lewat `MODEL_OVERRIDES`) |
| `nvidia/llama-3.3-nemotron-super-49b-v1.5`, `deepseek-ai/deepseek-r1`, `meta/llama-3.3-70b-instruct` | nvidia | sama persis |
| `vaneus-4.0` | mistral | `MISTRAL_MODEL` (default `mistral-large-latest`) |
| `sonar-reasoning-pro`, `sonar-pro`, `sonar`, `sonar-deep-research` | perplexity | sama persis |
| `openrouter/free` | openrouter | `OPENROUTER_MODEL` (default `openrouter/auto`, Auto Router resminya OpenRouter) |
| `spectrax` | *(gabungan)* | coba `GEMINI_MODEL` dulu, fallback ke NVIDIA (`SPECTRAX_FALLBACK_MODEL`) kalau Gemini gagal karena availability |

Alias publik `/api/keys` & `/v1/chat` (`modelId`) → model publik di atas — persis
`APIKEY_MODEL_CATALOG` di frontend:

`auto-model→openrouter/free`, `spectrax→spectrax`, `vaneus-4.0→vaneus-4.0`,
`vaeltrix-nemotron→nvidia/llama-3.3-nemotron-super-49b-v1.5`, `vaeltrix-deepseek-r1→deepseek-ai/deepseek-r1`,
`vaeltrix-llama-70b-n→meta/llama-3.3-70b-instruct`, `vaeltrix-sonar-reasoning→sonar-reasoning-pro`,
`vaeltrix-sonar-pro→sonar-pro`, `vaeltrix-sonar→sonar`, `vaeltrix-sonar-deep-research→sonar-deep-research`,
`vaeltrix-thinking→qwen/qwen3.6-27b`, `vaeltrix-vision→openai/gpt-oss-20b`, `vaeltrix-ultra→openai/gpt-oss-120b`,
`vaeltrix-expert→llama-3.3-70b-versatile`, `vaeltrix-fast→llama-3.1-8b-instant`.

## Storage

- **Supabase** (auth/profile/conversation/credit dikelola frontend seperti biasa; backend ini
  SEKARANG ikut memanggil `GET /auth/v1/user` buat verifikasi sesi login — lihat
  `CHANGELOG-HARDENING.md`): `profiles`, `conversations`, RPC
  `deduct_credit`/`refresh_daily_credit`/`set_user_plan`. Semua soal kredit & plan ada di sana —
  backend ini **tidak** melakukan deduction kedua.
- **Backend ini** (SQLite bawaan Node `node:sqlite` kalau runtime-nya mendukung — Node ≥ 22.5,
  otomatis fallback ke file JSON atomic-write kalau tidak, tanpa perlu compile native addon apa
  pun — penting buat Termux): `api_keys`, `redeem_codes`, `redeem_redemptions`. Cek log saat
  start untuk tahu mode mana yang lagi dipakai. Operasi check-then-write (limit key, redeem)
  dibungkus transaksi database beneran (lihat `CHANGELOG-HARDENING.md` HIGH-2).
- Backend **tidak** menyimpan isi chat, prompt, balasan AI, atau gambar yang diunggah — itu semua
  urusan localStorage/Supabase di frontend (sesuai kontrak, section "Data Privacy").

---

> Bagian "Laporan Audit" di bawah adalah audit REKONSTRUKSI awal (backend dibangun dari nol
> berdasarkan kontrak frontend). Untuk audit HARDENING KEAMANAN (putaran kedua — auth/ownership,
> rate limit, race condition, dst), lihat `SECURITY-AUDIT.md` dan `CHANGELOG-HARDENING.md`.

## Laporan Audit

### A. Kontrak frontend yang ditemukan (endpoint, method, header, payload, response)
Semua endpoint di atas ditemukan dengan menelusuri titik kontak `fetch(SERVER_URL...)` /
`callVaeltrixAPI(...)` di: `01-config-provider.js` (`/api/chat`), `04-account-settings.js`
(`/api/redeem`), `05-thinking-effort.js` (pemakaian `/api/chat` untuk vision & judul),
`08-streaming.js` (Multi Chat, tetap lewat `/api/chat`, `stream:false`, paralel),
`09-send-status.js` (chat normal + SSE parser + health check `GET /` + `/api/promo-featured`),
`CreateApikey/script.js` (`/api/keys*`). `Request-Update/script.js` memanggil `web3forms.com`
langsung (form kontak eksternal) — tidak terkait backend ini. Web search (DuckDuckGo) dan
generate gambar (`image.pollinations.ai`) juga dipanggil langsung oleh frontend, **tidak**
lewat backend — sesuai temuan, tidak dibuatkan endpoint baru untuk itu.

### B. Provider mapping
Lihat tabel di atas. Detail penting hasil audit:
- **`qwen/qwen3.6-27b`** adalah SATU-SATUNYA model vision (`VISION_MODEL` di frontend), walau di
  dropdown model berlabel **"Vaeltrix Thinking"** (bukan "Vaeltrix Vision"). Ini bukan salah ketik hasil
  reconstruction — persis begitu di source frontend-nya (`01-config-provider.js` baris
  `VISION_MODEL = 'qwen/qwen3.6-27b'`, sementara alias `vaeltrix-vision` di katalog API key malah
  menunjuk ke `openai/gpt-oss-20b`, model teks biasa di Groq). Backend mengikuti persis kondisi
  ini apa adanya, tidak "diperbaiki".
- ID model `qwen/qwen3.6-27b` tidak berhasil dikonfirmasi sebagai model yang benar-benar ada di
  katalog resmi Groq per audit ini (Groq per dokumentasi resminya punya `qwen/qwen3-32b`, bukan
  `qwen3.6-27b`). Karena instruksi eksplisit untuk tidak mengubah ID model publik, ID ini
  **tetap dikirim apa adanya** ke Groq. Kalau Groq menolaknya (model tidak ditemukan), itu akan
  muncul sebagai error normal (`PROVIDER_MODEL_UNAVAILABLE`) — bukan dipalsukan seolah berhasil.
  Operator bisa perbaiki tanpa ubah kode lewat `MODEL_OVERRIDES` di `.env`, misalnya:
  `MODEL_OVERRIDES={"qwen/qwen3.6-27b":"qwen/qwen3-32b"}`.
- `vaneus-4.0` dan `openrouter/free` juga bukan ID model asli (masing-masing alias internal
  project ini) — di-map ke `MISTRAL_MODEL`/`OPENROUTER_MODEL` yang bisa dikonfigurasi tanpa ubah
  kode kalau provider berubah model andalannya.

### C. Storage
Lihat bagian "Storage" di atas.

### D. Security
- Provider API key hanya ada di server (`.env`), tidak pernah dikirim/di-echo ke client.
- `/api/chat`: `provider` dari client diabaikan, dihitung ulang dari `model` (registry
  allowlist) — mencegah kombinasi provider/model yang tidak sah. Parameter reasoning Groq
  di-allowlist (bukan blind pass-through seluruh body client ke upstream).
- Validasi ukuran body (`MAX_BODY_BYTES`, default ~15MB, cukup untuk 1 lampiran gambar) →
  `413` kalau kelebihan. Validasi model vision (`image_url` ditolak untuk model non-vision).
- Rate limit in-memory: umum di `/api/*` (60 req/menit per device/IP) dan lebih ketat khusus
  `/api/redeem` (8 req/menit per IP+device) — proteksi abuse infrastruktur, terpisah dari
  product message-limit yang memang sudah ditangani frontend sendiri.
- API key publik: string random panjang dari CSPRNG (`crypto.randomBytes`, bukan `Math.random`
  dan bukan turunan email/device id), disimpan per baris dengan `owner` buat isolasi antar user.
  **Catatan jujur:** karena halaman `CreateApikey` menampilkan ulang `key` mentah di daftar
  riwayat (bukan cuma sekali saat dibuat), backend menyimpan key apa adanya (bukan hash
  satu-arah) supaya bisa ditampilkan lagi sesuai kontrak — ini trade-off yang disengaja, bukan
  kelalaian. Amankan file database (`DATABASE_PATH`) di server seperti credential lain.
  Kepemilikan key juga masih berbasis `createdBy` (string biasa dari client, sesuai kontrak
  frontend saat ini) — arsitektur repository sudah dipisah (`db/repositories/`) supaya nanti
  gampang ditingkatkan ke Supabase JWT tanpa rewrite total, tapi peningkatan itu sendiri
  **belum** diimplementasikan di sini karena frontend saat ini memang belum mengirim JWT apapun
  ke endpoint ini.
- `/v1/chat`: auth Bearer wajib, model dipaksa ikut yang terikat ke key (tidak bisa
  di-override lewat body) supaya API key model-bound tidak percuma.
- Redeem: rate-limited, cek `active`/`expiresAt`/`maxUses`, plus proteksi 1 device = 1 kali
  redeem per kode (X-Device-Id) — bukan mekanisme keamanan bernilai tinggi (device id gampang
  di-reset), tapi cukup buat cegah penyalahgunaan kasual sesuai catatan MASTER PROMPT.
- Semua error provider dinormalisasi (tidak membocorkan response mentah/credential upstream);
  stack trace tidak pernah dikirim ke client; log otomatis redact field sensitif.
- CORS, timeout upstream (`UPSTREAM_TIMEOUT_MS`), dan penghormatan `AbortController`
  (disconnect client memutus request ke provider) sudah diimplementasikan.
- Field `api_key_count` ada di skema Supabase (`supabase-schema.sql`) yang sepertinya dimaksudkan
  buat batasi jumlah API key per akun (kartu paket UI juga menyebut "Limit Pembuatan Key: 1×"),
  tapi baik frontend (`CreateApikey/script.js`) maupun kontrak yang diberikan **tidak** benar-benar
  menegakkan limit ini di mana pun saat audit dilakukan. Backend ini sengaja **tidak** menambahkan
  pembatasan itu sendiri (supaya tidak mengarang perilaku baru yang bisa bikin frontend
  menampilkan error yang tidak ia mengerti) — kalau memang mau ditegakkan, ini area yang jelas
  butuh keputusan produk dulu, baru diimplementasikan di `api-key.service.js`.

### E. Compatibility
Status audit REKONSTRUKSI awal: frontend bisa dipakai tanpa perubahan apapun asal `SERVER_URL`
diarahkan ke server ini dan minimal 1 provider API key diisi. **Update dari audit HARDENING**:
`chat/CreateApikey/index.html` dan `chat/CreateApikey/script.js` sejak itu mengalami 2 perubahan
kecil (tambah Supabase SDK, baca `keyPreview` bukan `key`) — lihat `CHANGELOG-HARDENING.md` untuk
detail FILE/OLD/NEW/REASON/IMPACT/MIGRATION lengkap. Sisanya (`chat/index.html`,
`Request-Update/`) tetap tidak berubah sama sekali.

## Testing yang sudah dilakukan

**Automated (baru, ikut dikirim di `tests/`, jalan tiap saat lewat `npm test`, tanpa dependency
tambahan — pakai `node:test` bawaan):** 79 test lulus per commit ini, mencakup semua endpoint,
kedua backend storage (SQLite & fallback JSON, termasuk audit rollback transaksi), **2 test
konkurensi ASLI pakai `Promise.all` beneran** (bukan simulasi) yang membuktikan limit API key &
`maxUses` redeem code tidak bisa dilewati request paralel, rate limit 2 lapis `/v1/chat`, dan
verifikasi ownership Supabase (token valid/invalid/tidak ada, migrasi key lama). Rinciannya ada
di `SECURITY-AUDIT.md` per temuan.

Karena lingkungan pembuatan backend ini tidak punya akses internet keluar (jadi tidak bisa
memanggil Groq/NVIDIA/dst maupun Supabase yang asli), pengujian dilakukan dengan server tiruan
lokal yang meniru persis format response OpenAI-compatible dan Supabase Auth API (sukses, error,
SSE, timeout, disconnect), untuk memverifikasi: parsing & validasi request, normalisasi error
(`{error:{message,code}}` vs `{error:"..."}` khusus redeem), relay SSE byte-per-byte sampai
`[DONE]`, penghormatan abort, alur lengkap `/api/keys` (create/list/delete + isolasi antar owner +
limit + ownership Supabase), `/api/redeem` (sukses, kode salah, sudah dipakai device yang sama,
kadaluarsa, maxUses tercapai, konkurensi), `/api/promo-featured`,
dan fallback Spectrax (Gemini gagal → NVIDIA). **Belum** diuji melawan API asli
Groq/NVIDIA/Mistral/Perplexity/OpenRouter/Gemini — sebelum production, jalankan dulu tes nyata
dengan API key asli (lihat contoh curl di atas) seperti yang disarankan MASTER PROMPT bagian 59-60.
