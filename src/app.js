'use strict';

const express = require('express');
const env = require('./config/env');
const corsMiddleware = require('./middleware/cors');
const securityHeaders = require('./middleware/security-headers');
const { errorHandler, notFoundHandler } = require('./middleware/error-handler');
const logger = require('./utils/logger');
const { generateRequestId } = require('./utils/id');

const chatRoutes = require('./routes/chat.routes');
const keysRoutes = require('./routes/keys.routes');
const redeemRoutes = require('./routes/redeem.routes');
const publicRoutes = require('./routes/public.routes');

function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.use(corsMiddleware);
  app.use(securityHeaders);
  app.use(express.json({ limit: env.maxBodyBytes }));

  // Request ID: dipakai buat nyambungin error yang diliat user/frontend ke baris log server
  // yang bersangkutan (X-Request-Id di response header + ikut di tiap baris log request ini).
  app.use((req, res, next) => {
    req.id = req.get('x-request-id') || generateRequestId();
    res.set('X-Request-Id', req.id);
    next();
  });

  // Log ringkas per request (metode, path, status, durasi, request id) — TANPA body/header sensitif.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.info('request', { id: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start });
    });
    next();
  });

  // GET / — health check. Frontend mengecek ini tiap 30 detik (checkServerHealth di
  // 09-send-status.js) buat nampilin/nyembunyiin banner "server down".
  app.get('/', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'OxyChat API' });
  });

  app.use('/api', chatRoutes);
  app.use('/api', keysRoutes);
  app.use('/api', redeemRoutes);
  app.use('/v1', publicRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
