'use strict';

const cors = require('cors');
const env = require('../config/env');

/**
 * CORS_ORIGINS di .env: daftar origin dipisah koma, atau "*"/kosong buat izinin semua.
 * Endpoint di backend ini gak pakai cookie/session (auth cuma lewat header Bearer/body),
 * jadi "*" masih relatif aman, tapi tetep disaranin dibatasi ke domain frontend beneran
 * pas production (lihat komentar di .env.example).
 */
const options = {
  origin: env.corsOrigins === '*' ? true : env.corsOrigins,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Id'],
  maxAge: 86400,
};

module.exports = cors(options);
