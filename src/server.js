'use strict';

const env = require('./config/env');
const logger = require('./utils/logger');
const { createApp } = require('./app');
const { getDb } = require('./db/database');

function logProviderStatus() {
  for (const [name, available] of Object.entries(env.providerAvailable)) {
    logger.info(`provider_${available ? 'available' : 'unavailable'}`, { provider: name });
  }
  if (!env.anyProviderAvailable) {
    logger.warn('no_provider_configured', {
      note: 'Semua provider API key kosong — server tetap jalan, tapi /api/chat & /v1/chat akan selalu gagal sampai minimal 1 provider dikonfigurasi di .env',
    });
  }
}

function main() {
  logProviderStatus();
  getDb(); // buka/siapin storage lebih awal biar ketauan dari awal kalau ada masalah storage

  const app = createApp();
  const server = app.listen(env.port, () => {
    logger.info('server_started', { port: env.port, env: env.nodeEnv });
  });

  server.requestTimeout = 0; // biarin request streaming lama tanpa dipotong paksa oleh Node
  server.keepAliveTimeout = 65000;

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown_start', { signal });
    server.close(() => {
      try {
        getDb().close();
      } catch (_) {}
      logger.info('shutdown_complete');
      process.exit(0);
    });
    // Jaga-jaga ada koneksi streaming yang gantung — paksa keluar kalau lebih dari 10 detik.
    setTimeout(() => process.exit(1), 10000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
