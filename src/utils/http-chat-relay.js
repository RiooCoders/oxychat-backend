'use strict';

const { Readable } = require('node:stream');
const logger = require('./logger');
const { ApiError, internal } = require('./errors');
const { createSseFilterTransform } = require('./sse-think-filter');
const { sanitizeCompletionPayload } = require('./sanitize-content');

function sendError(res, err) {
  const apiErr = err instanceof ApiError ? err : internal(err.message, 'INTERNAL_ERROR', { cause: err });
  if (!(err instanceof ApiError)) {
    logger.error('unhandled_chat_error', { id: res.req?.id, message: err.message, stack: err.stack });
  }
  const body = apiErr.toJSON();
  if (res.req?.id) body.error.requestId = res.req.id;
  res.status(apiErr.status).json(body);
}

function openSse(res) {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

/** Error yang terjadi SETELAH header SSE terkirim (mis. pencarian jalan dulu): HTTP status udah gak bisa diubah, jadi dikirim sebagai chunk. */
function sendSseError(res, err) {
  const apiErr = err instanceof ApiError ? err : internal(err.message, 'INTERNAL_ERROR', { cause: err });
  if (!(err instanceof ApiError)) {
    logger.error('unhandled_chat_error', { id: res.req?.id, message: err.message, stack: err.stack });
  }
  const body = apiErr.toJSON();
  if (res.req?.id) body.error.requestId = res.req.id;
  try {
    if (!res.writableEnded) {
      res.write('data: ' + JSON.stringify(body) + '\n\n');
      res.write('data: [DONE]\n\n');
    }
  } catch (_) {}
  if (!res.writableEnded) res.end();
}

function pipeSse(res, upstreamResponse, { keepThinking = false, alreadyOpen = false } = {}) {
  if (!alreadyOpen) openSse(res);

  const nodeStream = Readable.fromWeb(upstreamResponse.body);
  const sanitize = createSseFilterTransform({ keepThinking });
  let closedByClient = false;

  res.on('close', () => {
    if (!res.writableEnded) closedByClient = true;
  });

  const onError = (err) => {
    if (closedByClient) return;
    logger.warn('sse_relay_error', { message: err.message });
    if (!res.writableEnded) {
      try {
        res.write(
          'data: ' +
            JSON.stringify({ choices: [{ delta: { content: '\n\n[Koneksi ke provider terputus]' } }] }) +
            '\n\n'
        );
        res.write('data: [DONE]\n\n');
      } catch (_) {}
      res.end();
    }
  };

  nodeStream.on('error', onError);
  sanitize.on('error', onError);
  sanitize.on('end', () => {
    if (!res.writableEnded) res.end();
  });

  nodeStream.pipe(sanitize).pipe(res, { end: false });
}

/**
 * @param {Function} chatPromiseFactory (signal, events?) => Promise<hasil handleChat>
 * @param {{enableEvents?:boolean}} opts  enableEvents: kirim event status/sumber/penggantian model (chunk SSE `vaeltrix`) ke klien.
 *   Hanya dinyalain buat /api/chat (frontend sendiri). /v1/chat sengaja TIDAK, supaya stream-nya tetap
 *   murni OpenAI-compatible (klien pihak ketiga bisa error kalau ketemu chunk tanpa `choices`).
 */
async function runChatAndRespond(req, res, chatPromiseFactory, { enableEvents = false } = {}) {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const wantsStream = Boolean(req.body && req.body.stream === true);
  let sseOpen = false;
  const emit = (obj) => {
    if (sseOpen && !res.writableEnded) res.write('data: ' + JSON.stringify({ vaeltrix: obj }) + '\n\n');
  };
  const events =
    enableEvents && wantsStream
      ? {
          // Dibuka paling awal supaya UI bisa nampilin "Mencari di web..." selama pencarian jalan.
          status(name) {
            if (!sseOpen && !res.headersSent) {
              openSse(res);
              sseOpen = true;
            }
            emit({ status: name });
          },
          web(meta) {
            emit({ web: meta });
          },
          // Pesan ditandai filter keamanan lalu dijawab model lain: UI nampilin catatan kecil.
          switched(info) {
            if (!sseOpen && !res.headersSent) {
              openSse(res);
              sseOpen = true;
            }
            emit({ switched: info });
          },
        }
      : undefined;

  try {
    const result = await chatPromiseFactory(controller.signal, events);
    if (result.stream) {
      if (result.switched && events) events.switched(result.switched);
      pipeSse(res, result.upstream, { keepThinking: Boolean(result.keepThinking), alreadyOpen: sseOpen });
    } else {
      // idempotent: data sudah dinormalisasi di chat.service, ini cuma jaring pengaman kedua
      res.status(200).json(sanitizeCompletionPayload(result.data, { keepThinking: Boolean(result.keepThinking) }));
    }
  } catch (err) {
    if (controller.signal.aborted) return;
    if (sseOpen) sendSseError(res, err);
    else sendError(res, err);
  }
}

module.exports = { runChatAndRespond, sendError, pipeSse };
