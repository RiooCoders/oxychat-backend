'use strict';

const crypto = require('node:crypto');
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomBase62(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function generateId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${randomBase62(10)}`;
}

function generateApiKey() {
  return `vaeltrix_${randomBase62(40)}`;
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function previewApiKey(key) {
  if (!key || key.length < 14) return '****';
  return key.slice(0, 8) + '\u2026' + key.slice(-4);
}

function generateRedeemCode(length = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // tanpa karakter yg gampang ketuker (0/O, 1/I)
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function generateRequestId() {
  return `req_${Date.now().toString(36)}${randomBase62(8)}`;
}

module.exports = { generateId, generateApiKey, generateRedeemCode, generateRequestId, hashApiKey, previewApiKey };
