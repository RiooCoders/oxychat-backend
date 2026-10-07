'use strict';

const crypto = require('node:crypto');
const env = require('../config/env');
const logger = require('../utils/logger');
const { raceAbort } = require('../utils/abort');
const { UpstreamError } = require('../utils/upstream-http');
const { ByteLruCache } = require('../utils/lru-cache');
const { createSemaphore } = require('../utils/semaphore');
const { ApiError, badRequest, tooManyRequests } = require('../utils/errors');
const { resolveSpeed, resolveLanguage } = require('../config/voice-options');
const { PRESETS, FEMALE_ORDER, MALE_ORDER, BUILTIN_VOICES, LABEL_ID } = require('../config/voice-presets');
const { elevenRequest } = require('./elevenlabs.client');
const { mapVoiceUpstreamError, isAbortError, isAccountLevelError } = require('./voice-errors');

const cfg = () => env.voice.elevenlabs;
const ttsCfg = () => env.voice.tts;

const BLOCK_VOICE_MS = 6 * 60 * 60 * 1000; // suara yang ditolak ElevenLabs (404/402) disingkirkan 6 jam
const BAD_MODEL_MS = 60 * 60 * 1000;
const CIRCUIT_MS = 60 * 1000; // error level-akun (key invalid/kuota habis/diblokir): gagal cepat 1 menit, jangan hajar ElevenLabs terus
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SPEND_ENTRIES = 20000;

const state = {
  rawVoices: null, // suara hasil normalisasi (dari API / daftar bawaan), belum dikurasi
  fetchedAt: 0,
  inflight: null,
  blocked: new Map(), // voiceId -> kedaluwarsa
  badModels: new Map(), // model -> kedaluwarsa
  circuit: null, // { until, status, code, message }
};
let audioCache = new ByteLruCache(ttsCfg().audioCacheMaxBytes);
let semaphore = createSemaphore(cfg().maxConcurrency);
const clientSpend = new Map(); // 'd:<device>' | 'i:<ip>' -> { start, chars }

function isConfigured() {
  return Boolean(cfg().apiKey);
}

/** Dipakai test untuk mulai dari kondisi bersih dengan konfigurasi env terbaru. */
function reset() {
  state.rawVoices = null;
  state.fetchedAt = 0;
  state.inflight = null;
  state.blocked.clear();
  state.badModels.clear();
  state.circuit = null;
  clientSpend.clear();
  audioCache = new ByteLruCache(ttsCfg().audioCacheMaxBytes);
  semaphore = createSemaphore(cfg().maxConcurrency);
}

// ------------------------------------------------------------------ katalog suara

function shortName(name) {
  // Suara generasi baru bernama "Talia - Warm Soft Guide": ambil bagian depannya saja.
  return String(name || '').split(/\s+[-\u2013\u2014]\s+/)[0].trim();
}

function safeUrl(u) {
  try {
    const x = new URL(String(u));
    if (x.protocol === 'https:') return x.toString();
    if (x.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(x.hostname)) return x.toString();
  } catch (_) {
    /* abaikan */
  }
  return '';
}

function taglineFromLabels(labels) {
  const pick = (v) => LABEL_ID[String(v || '').toLowerCase().replace(/[\s-]+/g, '_')] || '';
  const parts = [...new Set([pick(labels.descriptive), pick(labels.use_case || labels.usecase)].filter(Boolean))];
  return parts.length ? parts.slice(0, 2).join(' & ') : 'Suara natural';
}

function normalizeApiVoice(v) {
  const labels = v && v.labels && typeof v.labels === 'object' ? v.labels : {};
  const name = shortName(v.name) || String(v.name || '');
  const key = name.toLowerCase();
  const preset = PRESETS[key];
  let gender = String(labels.gender || '').toLowerCase();
  if (gender !== 'female' && gender !== 'male') gender = preset ? preset.gender : 'neutral';
  return {
    id: String(v.voice_id),
    name,
    key,
    gender,
    category: String(v.category || ''),
    useCase: String(labels.use_case || labels.usecase || ''),
    accent: String(labels.accent || ''),
    tagline: preset ? preset.tagline : taglineFromLabels(labels),
    previewUrl: safeUrl(v.preview_url),
    explicit: Boolean(v._explicit),
  };
}

function toPublic(v) {
  return { id: v.id, name: v.name, gender: v.gender, tagline: v.tagline, accent: v.accent, previewUrl: v.previewUrl };
}

function rankOf(order) {
  return (v) => {
    const i = order.indexOf(v.key);
    return i === -1 ? 1000 : i;
  };
}

function sortStable(list, order) {
  const rank = rankOf(order);
  return list
    .map((v, i) => ({ v, i }))
    .sort((a, b) => rank(a.v) - rank(b.v) || a.i - b.i)
    .map((x) => x.v);
}

/**
 * Pilih suara yang ditampilkan ke user: seimbang perempuan/laki-laki, urut sesuai prioritas "natural",
 * selang-seling supaya geser carousel terasa bervariasi. Suara yang diblokir dibuang.
 */
function curateVoices(voices, { max = 6, categories = ['premade'], blocked = new Set() } = {}) {
  const usable = voices.filter((v) => !blocked.has(v.id));

  // Operator menentukan sendiri lewat ELEVENLABS_VOICE_IDS: hormati isi & urutannya persis.
  const explicit = usable.filter((v) => v.explicit);
  if (explicit.length) return explicit.slice(0, 12).map(toPublic);

  let pool = usable.filter((v) => !v.category || categories.includes(v.category));
  // Akun tanpa suara "premade": pakai suara apa pun di akun, kecuali suara library berbayar.
  if (!pool.length) pool = usable.filter((v) => v.category !== 'professional' && v.category !== 'high_quality');
  const noCharacters = pool.filter((v) => !/character|animation/i.test(v.useCase));
  if (noCharacters.length) pool = noCharacters;
  const seen = new Set();
  pool = pool.filter((v) => (seen.has(v.key) ? false : (seen.add(v.key), true)));

  const females = sortStable(pool.filter((v) => v.gender === 'female'), FEMALE_ORDER);
  const males = sortStable(pool.filter((v) => v.gender === 'male'), MALE_ORDER);
  const others = pool.filter((v) => v.gender !== 'female' && v.gender !== 'male');

  const nF = Math.ceil(max / 2);
  const nM = Math.floor(max / 2);
  let pickF = females.slice(0, nF);
  let pickM = males.slice(0, nM);
  let need = max - pickF.length - pickM.length;
  if (need > 0) {
    const extra = females.slice(pickF.length, pickF.length + need);
    pickF = pickF.concat(extra);
    need -= extra.length;
  }
  if (need > 0) {
    const extra = males.slice(pickM.length, pickM.length + need);
    pickM = pickM.concat(extra);
    need -= extra.length;
  }
  const picked = [];
  for (let i = 0; i < Math.max(pickF.length, pickM.length); i += 1) {
    if (pickF[i]) picked.push(pickF[i]);
    if (pickM[i]) picked.push(pickM[i]);
  }
  if (picked.length < max) picked.push(...others.slice(0, max - picked.length));
  return picked.map(toPublic);
}

function activeBlockedSet() {
  const now = Date.now();
  const out = new Set();
  for (const [id, until] of state.blocked) {
    if (until > now) out.add(id);
    else state.blocked.delete(id);
  }
  return out;
}

function buildCatalog() {
  const voices = curateVoices(state.rawVoices || [], {
    max: cfg().maxVoices,
    categories: cfg().voiceCategories,
    blocked: activeBlockedSet(),
  });
  return {
    available: voices.length > 0,
    ...(voices.length ? {} : { reason: 'no_voices' }),
    voices,
    defaultVoiceId: voices[0] ? voices[0].id : null,
  };
}

async function fetchLegacyVoices() {
  const data = await elevenRequest('GET', '/v1/voices', {});
  return Array.isArray(data && data.voices) ? data.voices : [];
}

async function fetchAllVoices() {
  const out = [];
  let token = null;
  for (let page = 0; page < 5; page += 1) {
    const query = { page_size: 100, include_total_count: 'false' };
    if (token) query.next_page_token = token;
    let data;
    try {
      data = await elevenRequest('GET', '/v2/voices', { query });
    } catch (err) {
      if (page === 0 && err instanceof UpstreamError && [404, 405].includes(err.status)) return fetchLegacyVoices();
      throw err;
    }
    out.push(...(Array.isArray(data && data.voices) ? data.voices : []));
    if (!data || !data.has_more || !data.next_page_token) break;
    token = data.next_page_token;
  }
  return out;
}

/** ELEVENLABS_VOICE_IDS="id" atau "id:Nama:female|male" -> objek bentuk API (diperkaya dari daftar akun kalau ada). */
function resolveConfiguredVoices(items, apiVoices) {
  const byId = new Map((apiVoices || []).map((v) => [String(v.voice_id), v]));
  return items
    .map((item, i) => {
      const [id, nameRaw, genderRaw] = item.split(':').map((s) => s.trim());
      if (!id) return null;
      const merged = { ...(byId.get(id) || { voice_id: id, labels: {} }), voice_id: id, _explicit: true };
      if (nameRaw) merged.name = nameRaw;
      else if (!merged.name) merged.name = `Suara ${i + 1}`;
      const gender = /^f/i.test(genderRaw || '') ? 'female' : /^m/i.test(genderRaw || '') ? 'male' : '';
      if (gender) merged.labels = { ...(merged.labels || {}), gender };
      merged.category = merged.category || 'configured';
      return merged;
    })
    .filter(Boolean);
}

async function loadVoices() {
  let apiVoices = null;
  try {
    apiVoices = await fetchAllVoices();
  } catch (err) {
    const mapped = mapVoiceUpstreamError(err, { scope: 'TTS', provider: 'elevenlabs' });
    // API key dibatasi izinnya (gak boleh baca daftar suara) atau operator sudah menentukan suara sendiri:
    // tetap jalan tanpa daftar. Selain itu laporkan error aslinya.
    if (mapped.code === 'TTS_KEY_PERMISSION' || cfg().voiceIds.length > 0) {
      logger.warn('tts_voice_list_unavailable', { code: mapped.code, usingConfiguredIds: cfg().voiceIds.length > 0 });
    } else {
      throw mapped;
    }
  }
  const voices = cfg().voiceIds.length ? resolveConfiguredVoices(cfg().voiceIds, apiVoices) : apiVoices || BUILTIN_VOICES;
  state.rawVoices = voices.filter((v) => v && v.voice_id).map(normalizeApiVoice);
  state.fetchedAt = Date.now();
  logger.info('tts_voices_loaded', { total: state.rawVoices.length, shown: buildCatalog().voices.length });
}

/** Katalog yang ditampilkan ke user. Di-cache `voicesCacheMs`; kalau refresh gagal, data lama tetap dipakai. */
async function getCatalog({ force = false, signal } = {}) {
  if (!isConfigured()) return { available: false, reason: 'not_configured', voices: [], defaultVoiceId: null };
  const fresh = state.rawVoices && Date.now() - state.fetchedAt < cfg().voicesCacheMs;
  if (!fresh || force) {
    if (!state.inflight) {
      state.inflight = loadVoices().finally(() => {
        state.inflight = null;
      });
      state.inflight.catch(() => {}); // cegah unhandled rejection kalau semua yang menunggu sudah membatalkan
    }
    try {
      await raceAbort(state.inflight, signal, () => new UpstreamError({ kind: 'aborted', message: 'aborted' }));
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (!state.rawVoices) throw err;
      logger.warn('tts_voice_list_stale_served', { code: err && err.code, message: err && err.message });
    }
  }
  return buildCatalog();
}

function blockVoice(voiceId, reason) {
  state.blocked.set(voiceId, Date.now() + BLOCK_VOICE_MS);
  logger.warn('tts_voice_blocked', { voiceId, reason });
}

// ------------------------------------------------------------------ batas pemakaian

function budgetsFor(client) {
  const cap = ttsCfg().maxCharsPerClientPerDay;
  if (!cap || !client) return [];
  const list = [];
  if (client.device) list.push({ key: `d:${client.device}`, cap });
  if (client.ip) list.push({ key: `i:${client.ip}`, cap: cap * 5 }); // satu IP bisa dipakai banyak orang (CGNAT), jadi lebih longgar
  return list;
}

function spentNow(key) {
  const e = clientSpend.get(key);
  if (!e) return 0;
  if (Date.now() - e.start >= DAY_MS) {
    clientSpend.delete(key);
    return 0;
  }
  return e.chars;
}

function assertBudgets(budgets, chars) {
  for (const b of budgets) {
    if (spentNow(b.key) + chars > b.cap) {
      throw tooManyRequests('Batas suara harian tercapai, coba lagi besok', 'TTS_DAILY_LIMIT');
    }
  }
}

function recordSpend(budgets, chars) {
  for (const b of budgets) {
    let e = clientSpend.get(b.key);
    if (!e || Date.now() - e.start >= DAY_MS) {
      if (clientSpend.size >= MAX_SPEND_ENTRIES) clientSpend.delete(clientSpend.keys().next().value);
      e = { start: Date.now(), chars: 0 };
      clientSpend.set(b.key, e);
    }
    e.chars += chars;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [key, e] of clientSpend) if (now - e.start >= DAY_MS) clientSpend.delete(key);
}, 30 * 60 * 1000).unref();

// ------------------------------------------------------------------ sintesis suara

function sanitizeText(text) {
  if (typeof text !== 'string') throw badRequest('Teks wajib diisi', 'TTS_TEXT_REQUIRED');
  const clean = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean || !/[\p{L}\p{N}]/u.test(clean)) throw badRequest('Gak ada teks yang bisa dibacakan', 'TTS_TEXT_EMPTY');
  const max = ttsCfg().maxCharsPerRequest;
  if (clean.length > max) throw badRequest(`Teks terlalu panjang (maks ${max} karakter per permintaan)`, 'TTS_TEXT_TOO_LONG');
  return clean;
}

function modelsInOrder() {
  const now = Date.now();
  const list = cfg().ttsModels;
  const usable = list.filter((m) => !((state.badModels.get(m) || 0) > now));
  return usable.length ? usable : list;
}

async function callTts({ model, voiceId, text, speed, lang, signal }) {
  const body = {
    text,
    model_id: model,
    voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: speed.value },
  };
  if (lang !== 'auto') body.language_code = lang;
  const run = (b) =>
    elevenRequest('POST', `/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      query: { output_format: cfg().outputFormat },
      json: b,
      accept: 'audio/mpeg',
      as: 'buffer',
      signal,
    });
  try {
    return await run(body);
  } catch (err) {
    // Beberapa model gak mengenal language_code: ulangi sekali tanpa itu (model tetap mendeteksi bahasa dari teksnya).
    if (
      body.language_code &&
      err instanceof UpstreamError &&
      err.kind === 'http' &&
      [400, 422].includes(err.status) &&
      /language/i.test(`${err.code} ${err.message}`)
    ) {
      logger.warn('tts_language_code_rejected_retry', { model, lang });
      delete body.language_code;
      return run(body);
    }
    throw err;
  }
}

async function generate({ voice, text, speed, lang, signal }) {
  const models = modelsInOrder();
  let lastErr;
  for (const model of models) {
    try {
      const audio = await callTts({ model, voiceId: voice.id, text, speed, lang, signal });
      if (!audio || audio.length < 200) throw new ApiError(502, 'TTS_EMPTY_AUDIO', 'Layanan suara mengembalikan audio kosong, coba lagi');
      return { audio, model };
    } catch (err) {
      lastErr = err;
      const modelProblem =
        err instanceof UpstreamError &&
        err.kind === 'http' &&
        [400, 404, 422].includes(err.status) &&
        /model/i.test(`${err.code} ${err.message}`);
      if (modelProblem) {
        state.badModels.set(model, Date.now() + BAD_MODEL_MS);
        logger.warn('tts_model_rejected_trying_next', { model, status: err.status, code: err.code });
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function toApiError(err, voice) {
  if (isAbortError(err)) return err;
  if (err instanceof ApiError) return err;
  const mapped = mapVoiceUpstreamError(err, { scope: 'TTS', provider: 'elevenlabs' });
  if (err instanceof UpstreamError && err.kind === 'http' && voice) {
    if (err.status === 404 || err.status === 402 || /voice_not_found|paid_plan_required|payment_required/i.test(String(err.code))) {
      blockVoice(voice.id, `${err.status} ${err.code}`);
    }
  }
  if (isAccountLevelError(mapped)) {
    state.circuit = { until: Date.now() + CIRCUIT_MS, status: mapped.status, code: mapped.code, message: mapped.message };
  }
  return mapped;
}

function checkCircuit() {
  const c = state.circuit;
  if (!c) return;
  if (c.until <= Date.now()) {
    state.circuit = null;
    return;
  }
  throw new ApiError(c.status, c.code, c.message);
}

/**
 * Bikin audio MP3 dari teks.
 * @param {{text:string, voiceId?:string, speed?:string|number, language?:string, client?:{device?:string, ip?:string}, signal?:AbortSignal}} p
 * @returns {Promise<{audio:Buffer, cached:boolean, voiceId:string, chars:number}>}
 * Melempar ApiError (pesan Indonesia) atau UpstreamError{kind:'aborted'} kalau klien membatalkan.
 */
async function synthesize({ text, voiceId, speed, language, client, signal }) {
  if (!isConfigured()) throw new ApiError(503, 'TTS_NOT_CONFIGURED', 'Layanan suara belum diaktifkan di server');
  checkCircuit();
  const clean = sanitizeText(text);
  const sp = resolveSpeed(speed);
  if (!sp) throw badRequest('Kecepatan suara tidak valid', 'TTS_BAD_SPEED');
  const lang = resolveLanguage(language);
  if (!lang) throw badRequest('Bahasa tidak didukung', 'TTS_BAD_LANGUAGE');

  let catalog;
  try {
    catalog = await getCatalog({ signal });
  } catch (err) {
    throw toApiError(err);
  }
  if (!catalog.available) throw new ApiError(503, 'TTS_NO_VOICES', 'Belum ada suara yang tersedia di akun ElevenLabs');
  let voice = catalog.voices[0];
  if (voiceId) {
    voice = catalog.voices.find((v) => v.id === voiceId);
    if (!voice) throw badRequest('Suara tidak dikenal, buka Pengaturan Suara dan pilih lagi', 'TTS_VOICE_UNKNOWN');
  }

  const cacheKey = crypto
    .createHash('sha256')
    .update(JSON.stringify([voice.id, cfg().ttsModels[0], cfg().outputFormat, sp.value, lang, clean]))
    .digest('hex');
  const hit = audioCache.get(cacheKey);
  if (hit) return { audio: hit, cached: true, voiceId: voice.id, chars: clean.length };

  const budgets = budgetsFor(client);
  assertBudgets(budgets, clean.length);

  let release;
  try {
    release = await semaphore.acquire({ timeoutMs: cfg().queueWaitMs, signal });
  } catch (err) {
    if (err && err.code === 'ABORTED') throw new UpstreamError({ kind: 'aborted', message: 'aborted' });
    throw new ApiError(503, 'TTS_BUSY', 'Layanan suara lagi sibuk, coba lagi sebentar');
  }

  const startedAt = Date.now();
  try {
    const { audio, model } = await generate({ voice, text: clean, speed: sp, lang, signal });
    recordSpend(budgets, clean.length);
    audioCache.set(cacheKey, audio, audio.length);
    logger.info('tts_generated', { voice: voice.name, model, chars: clean.length, bytes: audio.length, ms: Date.now() - startedAt });
    return { audio, cached: false, voiceId: voice.id, chars: clean.length };
  } catch (err) {
    throw toApiError(err, voice);
  } finally {
    release();
  }
}

module.exports = {
  isConfigured,
  getCatalog,
  synthesize,
  _internal: { curateVoices, normalizeApiVoice, sanitizeText, resolveConfiguredVoices, state, reset },
};
