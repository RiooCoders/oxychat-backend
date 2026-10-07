'use strict';

/**
 * Deteksi format audio dari BYTE AWAL file (magic bytes) — bukan dari Content-Type / nama file kiriman klien,
 * karena itu bisa dipalsuin. Dipakai /api/stt: cuma container audio yang dikenal yang diteruskan ke penyedia STT.
 * Mengembalikan { ext, mime } atau null kalau bukan audio yang didukung.
 */
function detectAudioType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  const ascii = (start, end) => buf.toString('latin1', start, end);

  // WebM / Matroska (EBML header) — hasil MediaRecorder Chrome/Edge/Firefox/Android
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { ext: 'webm', mime: 'audio/webm' };
  // Ogg (Opus/Vorbis) — MediaRecorder Firefox
  if (ascii(0, 4) === 'OggS') return { ext: 'ogg', mime: 'audio/ogg' };
  // MP4 / M4A — MediaRecorder Safari/iOS
  if (ascii(4, 8) === 'ftyp') return { ext: 'm4a', mime: 'audio/mp4' };
  // WAV
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return { ext: 'wav', mime: 'audio/wav' };
  // FLAC
  if (ascii(0, 4) === 'fLaC') return { ext: 'flac', mime: 'audio/flac' };
  // MP3 (tag ID3 atau frame sync 0xFFEx)
  if (ascii(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { ext: 'mp3', mime: 'audio/mpeg' };
  return null;
}

module.exports = { detectAudioType };
