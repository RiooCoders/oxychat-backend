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
const voiceRoutes = require('./routes/voice.routes');

function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.use(corsMiddleware);
  app.use(securityHeaders);
  app.use(express.json({ limit: env.maxBodyBytes }));

  app.use((req, res, next) => {
    req.id = req.get('x-request-id') || generateRequestId();
    res.set('X-Request-Id', req.id);
    next();
  });

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.info('request', {
        id: req.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
      });
    });
    next();
  });

  // Health check ringan untuk halaman status: tanpa data internal.
  app.get('/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ status: 'ok', uptime: Math.round(process.uptime()) });
  });

  // FIX: health check sekarang ikut nunjukin provider mana yang key-nya kebaca
  app.get('/', (req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'VaeltrixAI - Server - Online',
      providers: env.providerAvailable,
      voice: { tts: env.voiceAvailable.tts, stt: env.voiceAvailable.stt.any },
    });
  });

  app.use('/api', chatRoutes);
  app.use('/api', keysRoutes);
  app.use('/api', redeemRoutes);
  app.use('/api', voiceRoutes);
  app.use('/v1', publicRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
