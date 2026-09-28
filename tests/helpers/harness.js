'use strict';

/**
 * Harness bersama dipakai semua file di tests/*.test.js. Bukan file test itu sendiri (gak
 * cocok pola *.test.js Node test runner, jadi gak ikut dijalanin sebagai test kosong).
 *
 * Setiap file test jalan di PROSES TERPISAH (perilaku default `node --test`), jadi tiap file
 * aman bikin harness sendiri (port/env sendiri) tanpa nabrak file test lain yang jalan paralel.
 */

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (_) {
        resolve({});
      }
    });
  });
}

/** Tiruan seluruh provider AI (Groq/NVIDIA/Mistral/Perplexity/OpenRouter/Gemini) — 1 server,
 * dibedain lewat Bearer token di header Authorization. `scenario[token]` nentuin perilaku:
 * 'ok' (default), 'auth_fail', 'model_not_found', 'server_error', 'hang'. */
function createMockUpstream() {
  const scenario = { default: 'ok' };
  const lastRequestByKey = {};

  const server = http.createServer(async (req, res) => {
    const auth = req.headers['authorization'] || '';
    const key = auth.replace(/^Bearer\s+/i, '');
    lastRequestByKey[key] = { path: req.url, closedEarly: false };
    res.on('close', () => {
      if (!res.writableEnded) lastRequestByKey[key].closedEarly = true;
    });

    const body = await readJsonBody(req);
    const behavior = scenario[key] || scenario.default;

    if (behavior === 'auth_fail') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Invalid API key provided' } }));
    }
    if (behavior === 'model_not_found') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'The model does not exist' } }));
    }
    if (behavior === 'server_error') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'internal server error' } }));
    }
    if (behavior === 'hang') return; // sengaja gak pernah respond -> tes upstream timeout

    if (behavior === 'fail_midstream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Halo' } }] }) + '\n\n');
      setTimeout(() => req.socket.destroy(), 60); // putus paksa di tengah, TANPA [DONE]
      return;
    }

    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Ha' } }] }) + '\n\n');
      setTimeout(() => {
        if (res.writableEnded) return;
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }, 120);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'mock:' + body.model,
              ...(body.reasoning_effort ? { reasoning_content: 'mikir dulu...' } : {}),
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      })
    );
  });

  return { server, scenario, lastRequestByKey };
}

/** Tiruan Supabase Auth (`GET /auth/v1/user`) + Tiruan RPC `admin_grant_plan` (HARDENING lanjutan,
 * CRITICAL-3 Phase 2 — dipanggil supabase-admin.service.js pakai service_role key).
 * `users` = Map token -> {id,email} yang valid. `grants` = array semua body request grant yang
 * masuk (buat diperiksa test). `setGrantShouldFail(true)` bikin RPC ini balikin error simulasi,
 * dipakai test buat mastiin jalur "gagal grant -> grantStatus:'failed', kode gak hilang". */
function createMockSupabaseAuth() {
  const users = new Map();
  const grants = [];
  let grantShouldFail = false;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/rest/v1/rpc/admin_grant_plan') && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch (_) {
          parsed = null;
        }
        grants.push(parsed);
        if (grantShouldFail) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'simulated grant failure' }));
        }
        res.writeHead(204);
        res.end();
      });
      return;
    }
    if (!req.url.startsWith('/auth/v1/user')) {
      res.writeHead(404);
      return res.end();
    }
    const auth = req.headers['authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    const user = users.get(token);
    if (!user) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid token' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: user.id, email: user.email }));
  });
  return { server, users, grants, setGrantShouldFail: (v) => (grantShouldFail = v) };
}

const REDIRECT_HOSTS = new Set([
  'api.groq.com',
  'integrate.api.nvidia.com',
  'api.mistral.ai',
  'api.perplexity.ai',
  'openrouter.ai',
  'generativelanguage.googleapis.com',
]);

/**
 * Siapin semuanya: mock upstream AI, mock Supabase auth, set env, patch fetch buat provider AI
 * (Supabase gak perlu di-patch — cukup arahin SUPABASE_URL langsung ke mock-nya), lalu boot
 * app ASLI (src/app.js, TANPA modifikasi apa pun) di port acak.
 */
async function setupHarness({ envOverrides = {}, dbName } = {}) {
  const mockUpstream = createMockUpstream();
  await listen(mockUpstream.server);
  const mockSupabase = createMockSupabaseAuth();
  await listen(mockSupabase.server);

  const dbPath = path.join(__dirname, '..', '.tmp-data', `${dbName || path.basename(require.main.filename)}.db`);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  for (const ext of ['.db', '.db-journal', '.json']) {
    fs.rmSync(dbPath.replace(/\.db$/, ext), { force: true });
  }

  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORT: '0',
    CORS_ORIGINS: '*',
    GROQ_API_KEY: 'key-groq',
    NVIDIA_API_KEY: 'key-nvidia',
    MISTRAL_API_KEY: 'key-mistral',
    PERPLEXITY_API_KEY: 'key-perplexity',
    OPENROUTER_API_KEY: 'key-openrouter',
    GEMINI_API_KEY: 'key-gemini',
    MISTRAL_MODEL: 'mistral-large-latest',
    OPENROUTER_MODEL: 'openrouter/auto',
    GEMINI_MODEL: 'gemini-flash-latest',
    SPECTRAX_FALLBACK_MODEL: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
    DATABASE_PATH: dbPath,
    UPSTREAM_TIMEOUT_MS: '700',
    MAX_BODY_BYTES: String(20 * 1024),
    ADMIN_TOKEN: '',
    SUPABASE_URL: `http://127.0.0.1:${mockSupabase.server.address().port}`,
    SUPABASE_ANON_KEY: 'test-anon-key',
    SUPABASE_AUTH_TIMEOUT_MS: '2000',
    // HARDENING lanjutan (CRITICAL-3 Phase 2): nilai default biar test redeem tipe "plan" gak
    // gagal cuma gara-gara key kosong -- test yang mau nguji jalur "gagal" pakai
    // mockSupabase.setGrantShouldFail(true), BUKAN dengan ngosongin key ini.
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    API_KEY_LIMIT_PER_OWNER: '1',
    V1_CHAT_RATE_LIMIT_PER_KEY: '60',
    V1_CHAT_RATE_LIMIT_PER_IP: '120',
    ...envOverrides,
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = new URL(typeof url === 'string' ? url : url.url);
    if (REDIRECT_HOSTS.has(u.hostname)) {
      return realFetch(`http://127.0.0.1:${mockUpstream.server.address().port}${u.pathname}`, opts);
    }
    return realFetch(url, opts);
  };

  const { createApp } = require('../../src/app');
  const app = createApp();
  const httpServer = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

  async function teardown() {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => httpServer.close(resolve));
    await new Promise((resolve) => mockUpstream.server.close(resolve));
    await new Promise((resolve) => mockSupabase.server.close(resolve));
    try {
      require('../../src/db/database').getDb().close();
    } catch (_) {}
  }

  return { baseUrl, mockUpstream, mockSupabase, teardown };
}

module.exports = { setupHarness };
