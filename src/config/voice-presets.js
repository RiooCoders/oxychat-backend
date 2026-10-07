'use strict';

/**
 * Preferensi pemilihan suara. Daftar suara SEBENARNYA selalu diambil langsung dari akun ElevenLabs
 * (GET /v2/voices) — file ini cuma menentukan URUTAN prioritas, gender cadangan, dan deskripsi singkat
 * bahasa Indonesia untuk suara yang dikenal. Kunci = nama pendek huruf kecil.
 *
 * Mencakup suara "default" generasi lama (Sarah, Roger, ...) DAN generasi baru yang menggantikannya
 * (Talia, Darian, ...). Suara yang gak ada di akun otomatis dilewati, jadi aman kalau ada yang kedaluwarsa.
 */
const PRESETS = {
  // ----- Perempuan -----
  sarah: { gender: 'female', tagline: 'Hangat & meyakinkan' },
  jessica: { gender: 'female', tagline: 'Ceria & santai' },
  alice: { gender: 'female', tagline: 'Jernih & ramah' },
  matilda: { gender: 'female', tagline: 'Tenang & profesional' },
  laura: { gender: 'female', tagline: 'Cerah & enerjik' },
  lily: { gender: 'female', tagline: 'Lembut & hangat' },
  talia: { gender: 'female', tagline: 'Hangat & lembut' },
  jade: { gender: 'female', tagline: 'Ceria & natural' },
  maisie: { gender: 'female', tagline: 'Ramah & santai' },
  alicia: { gender: 'female', tagline: 'Rapi & profesional' },
  elara: { gender: 'female', tagline: 'Tegas & jelas' },
  elowen: { gender: 'female', tagline: 'Ceria & modern' },
  florence: { gender: 'female', tagline: 'Tenang & hangat' },
  charlotte: { gender: 'female', tagline: 'Lembut & anggun' },
  aria: { gender: 'female', tagline: 'Ekspresif & jernih' },
  // ----- Laki-laki -----
  roger: { gender: 'male', tagline: 'Santai & akrab' },
  george: { gender: 'male', tagline: 'Hangat & berwibawa' },
  brian: { gender: 'male', tagline: 'Dalam & menenangkan' },
  eric: { gender: 'male', tagline: 'Halus & jernih' },
  daniel: { gender: 'male', tagline: 'Tegas & jernih' },
  charlie: { gender: 'male', tagline: 'Energik & percaya diri' },
  will: { gender: 'male', tagline: 'Santai & ramah' },
  chris: { gender: 'male', tagline: 'Natural & akrab' },
  liam: { gender: 'male', tagline: 'Cerah & informatif' },
  callum: { gender: 'male', tagline: 'Santai & bersahabat' },
  darian: { gender: 'male', tagline: 'Hangat & membumi' },
  eddie: { gender: 'male', tagline: 'Menenangkan & membantu' },
  caleb: { gender: 'male', tagline: 'Mantap & tepercaya' },
  finley: { gender: 'male', tagline: 'Jernih & artikulatif' },
  wyatt: { gender: 'male', tagline: 'Tenang & berpengalaman' },
  sawyer: { gender: 'male', tagline: 'Dalam & tenang' },
  warren: { gender: 'male', tagline: 'Santai & keren' },
  baxter: { gender: 'male', tagline: 'Tenang & datar' },
  eldrin: { gender: 'male', tagline: 'Berwibawa & jelas' },
  kellan: { gender: 'male', tagline: 'Santai & ramah' },
  lawrence: { gender: 'male', tagline: 'Cerah & informatif' },
  bill: { gender: 'male', tagline: 'Ramah & menenangkan' },
};

// Urutan prioritas (yang paling natural untuk membaca jawaban asisten AI ada di depan).
const FEMALE_ORDER = ['sarah', 'jessica', 'alice', 'matilda', 'laura', 'lily', 'talia', 'jade', 'maisie', 'alicia', 'elara', 'elowen', 'florence', 'charlotte', 'aria'];
const MALE_ORDER = ['roger', 'george', 'brian', 'eric', 'daniel', 'charlie', 'will', 'chris', 'liam', 'callum', 'darian', 'eddie', 'caleb', 'finley', 'wyatt', 'sawyer', 'warren', 'baxter', 'eldrin', 'kellan', 'lawrence', 'bill'];

/**
 * Cadangan kalau daftar suara gak bisa diambil karena API key dibatasi izinnya (mis. key "Text to Speech saja",
 * tanpa izin voices_read). ID ini suara default ElevenLabs yang umum; kalau ada yang salah/kedaluwarsa, suara itu
 * otomatis disingkirkan saat dipakai. Operator bisa menimpa lewat ELEVENLABS_VOICE_IDS.
 */
const BUILTIN_VOICES = [
  { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', labels: { gender: 'female' }, category: 'premade' },
  { voice_id: 'CwhRBWXzGAHq8TQ4Fs17', name: 'Roger', labels: { gender: 'male' }, category: 'premade' },
  { voice_id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica', labels: { gender: 'female' }, category: 'premade' },
  { voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', labels: { gender: 'male' }, category: 'premade' },
  { voice_id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice', labels: { gender: 'female' }, category: 'premade' },
  { voice_id: 'nPczCjzI2devNBz1zQrb', name: 'Brian', labels: { gender: 'male' }, category: 'premade' },
];

// Terjemahan label ElevenLabs (descriptive / use_case) ke bahasa Indonesia, buat suara yang gak ada di PRESETS.
const LABEL_ID = {
  warm: 'Hangat', calm: 'Tenang', confident: 'Percaya diri', casual: 'Santai', friendly: 'Ramah', professional: 'Profesional',
  cheerful: 'Ceria', upbeat: 'Ceria', deep: 'Dalam', soft: 'Lembut', smooth: 'Halus', clear: 'Jernih', crisp: 'Jernih',
  mature: 'Dewasa', young: 'Muda', energetic: 'Enerjik', intense: 'Tegas', friendly_casual: 'Ramah', natural: 'Natural',
  conversational: 'Percakapan', narration: 'Narasi', narrative_story: 'Narasi', informative_educational: 'Informatif',
  social_media: 'Media sosial', news: 'Berita', advertisement: 'Iklan', meditation: 'Menenangkan',
};

module.exports = { PRESETS, FEMALE_ORDER, MALE_ORDER, BUILTIN_VOICES, LABEL_ID };
