'use strict';

/**
 * Opsi suara yang dikirim ke frontend & divalidasi di server. Sumber kebenaran TUNGGAL:
 * frontend membaca daftar ini dari GET /api/tts/voices, server memakainya buat memvalidasi input.
 */

// Kecepatan bicara -> voice_settings.speed ElevenLabs (rentang yang diizinkan 0.7 - 1.2).
const SPEEDS = [
  { id: 'slow', label: 'Lambat', value: 0.85 },
  { id: 'normal', label: 'Normal', value: 1.0 },
  { id: 'fast', label: 'Cepat', value: 1.15 },
];

// Bahasa (kode ISO 639-1). 'auto' = model mendeteksi sendiri dari teksnya (pilihan terbaik untuk jawaban AI campur-campur).
// Kode yang sama dipakai buat STT (Whisper & Scribe sama-sama menerima ISO 639-1).
const LANGUAGES = [
  { code: 'auto', label: 'Otomatis' },
  { code: 'id', label: 'Indonesia' },
  { code: 'en', label: 'Inggris' },
  { code: 'ms', label: 'Melayu' },
  { code: 'ja', label: 'Jepang' },
  { code: 'ko', label: 'Korea' },
  { code: 'zh', label: 'Mandarin' },
  { code: 'ar', label: 'Arab' },
  { code: 'es', label: 'Spanyol' },
  { code: 'fr', label: 'Prancis' },
  { code: 'de', label: 'Jerman' },
  { code: 'pt', label: 'Portugis' },
  { code: 'ru', label: 'Rusia' },
  { code: 'hi', label: 'Hindi' },
  { code: 'tr', label: 'Turki' },
  { code: 'nl', label: 'Belanda' },
  { code: 'it', label: 'Italia' },
  { code: 'vi', label: 'Vietnam' },
  { code: 'pl', label: 'Polandia' },
  { code: 'sv', label: 'Swedia' },
];

const LANGUAGE_CODES = new Set(LANGUAGES.map((l) => l.code));

/** 'slow'|'normal'|'fast' atau angka 0.7-1.2 -> { id, value }. Selain itu null. */
function resolveSpeed(input) {
  if (input === undefined || input === null || input === '') return SPEEDS[1];
  const byId = SPEEDS.find((s) => s.id === input);
  if (byId) return byId;
  const n = Number(input);
  if (Number.isFinite(n) && n >= 0.7 && n <= 1.2) return { id: 'custom', value: Math.round(n * 100) / 100 };
  return null;
}

/** Kode bahasa valid (atau 'auto'). Selain itu null. */
function resolveLanguage(input) {
  if (input === undefined || input === null || input === '') return 'auto';
  const code = String(input).trim().toLowerCase();
  return LANGUAGE_CODES.has(code) ? code : null;
}

module.exports = { SPEEDS, LANGUAGES, resolveSpeed, resolveLanguage };
