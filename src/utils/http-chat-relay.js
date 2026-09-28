'use strict';

const { Readable } = require('node:stream');
const logger = require('./logger');
const { ApiError, internal } = require('./errors');

function sendError(res, err) {
  const apiErr = err instanceof ApiError ? err : internal(err.message, 'INTERNAL_ERROR', { cause: err });
  if (!(err instanceof ApiError)) logger.error('unhandled_chat_error', { id: res.req?.id, message: err.message, stack: err.stack });
  const body = apiErr.toJSON();
  if (res.req?.id) body.error.requestId = res.req.id;
  res.status(apiErr.status).json(body);
}

/** Relay byte-per-byte SSE dari upstream ke client. Upstream provider udah OpenAI-compatible,
 * jadi gak perlu di-parse ulang — cukup diteruskan apa adanya biar gak ada risiko salah format. */
function pipeSse(res, upstreamResponse) {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // matiin buffering reverse proxy (nginx dkk) biar beneran streaming
  });
  res.flushHeaders?.();

  const nodeStream = Readable.fromWeb(upstreamResponse.body);
  let closedByClient = false;

  // PENTING: pakai res.on('close'), BUKAN req.on('close'). req.on('close') di Node bisa kefire
  // begitu body request selesai DIBACA (jauh sebelum response ini kelar) — bukan cuma pas koneksi
  // client beneran putus — jadi salah kalau dipakai buat deteksi abort. res.on('close') baru fire
  // pas koneksi buat RESPONSE ini beneran ditutup, dan `res.writableEnded` bilang apakah itu normal
  // (udah kelar dikirim) atau prematur (client disconnect di tengah jalan).
  res.on('close', () => {
    if (!res.writableEnded) closedByClient = true;
  });

  nodeStream.on('error', (err) => {
    if (closedByClient) return; // client udah pergi, gak perlu ngapa-ngapain lagi
    logger.warn('sse_relay_error', { message: err.message });
    if (!res.writableEnded) {
      // Stream upstream putus di tengah jalan. Gak bisa ganti status code lagi (headers udah
      // kekirim), jadi kasih tau lewat konten SSE-nya sendiri biar user gak liat potongan diem-diem.
      try {
        res.write(
          'data: ' + JSON.stringify({ choices: [{ delta: { content: '\n\n[Koneksi ke provider terputus]' } }] }) + '\n\n'
        );
        res.write('data: [DONE]\n\n');
      } catch (_) {}
      res.end();
    }
  });
  nodeStream.on('end', () => {
    if (!res.writableEnded) res.end();
  });
  nodeStream.pipe(res, { end: false });
}

/**
 * Jalanin satu request chat lengkap: siapin AbortController yang otomatis abort kalau client
 * disconnect beneran, jalanin chatPromiseFactory(signal), lalu relay hasilnya (stream atau JSON
 * biasa) ke response. Dipakai bareng oleh /api/chat dan /v1/chat biar gak dobel logic.
 */
async function runChatAndRespond(req, res, chatPromiseFactory) {
  const controller = new AbortController();
  // Lihat catatan di pipeSse() soal kenapa res.on('close') (bukan req.on('close')) yang benar.
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const result = await chatPromiseFactory(controller.signal);
    if (result.stream) {
      pipeSse(res, result.upstream);
    } else {
      res.status(200).json(result.data);
    }
  } catch (err) {
    if (controller.signal.aborted) return; // client udah disconnect beneran, gak perlu balikin apapun lagi
    sendError(res, err);
  }
}

module.exports = { runChatAndRespond, sendError, pipeSse };
