'use strict';

const { Readable, Transform } = require('node:stream');
const logger = require('./logger');
const { ApiError, internal } = require('./errors');
const { sanitizeSseDataLine } = require('./sanitize-content');

function sendError(res, err) {
  const apiErr = err instanceof ApiError ? err : internal(err.message, 'INTERNAL_ERROR', { cause: err });
  if (!(err instanceof ApiError)) {
    logger.error('unhandled_chat_error', { id: res.req?.id, message: err.message, stack: err.stack });
  }
  const body = apiErr.toJSON();
  if (res.req?.id) body.error.requestId = res.req.id;
  res.status(apiErr.status).json(body);
}

/**
 * Transform stream: filter reasoning leak di SSE chunk demi chunk.
 * Buffer partial lines biar JSON SSE gak kepotong di tengah.
 */
function createSseSanitizeTransform() {
  let buffer = '';
  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        buffer += chunk.toString('utf8');
        const parts = buffer.split('\n');
        buffer = parts.pop() || '';
        let out = '';
        for (const part of parts) {
          const line = part.endsWith('\r') ? part.slice(0, -1) : part;
          if (line.startsWith('data:')) {
            out += sanitizeSseDataLine(line) + '\n';
          } else {
            out += part + '\n';
          }
        }
        if (out) this.push(out);
        cb();
      } catch (err) {
        cb(err);
      }
    },
    flush(cb) {
      try {
        if (buffer) {
          if (buffer.startsWith('data:')) this.push(sanitizeSseDataLine(buffer) + '\n');
          else this.push(buffer);
        }
        cb();
      } catch (err) {
        cb(err);
      }
    },
  });
}

function pipeSse(res, upstreamResponse) {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const nodeStream = Readable.fromWeb(upstreamResponse.body);
  const sanitize = createSseSanitizeTransform();
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

async function runChatAndRespond(req, res, chatPromiseFactory) {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const result = await chatPromiseFactory(controller.signal);
    if (result.stream) {
      pipeSse(res, result.upstream);
    } else {
      const { sanitizeCompletionPayload } = require('./sanitize-content');
      res.status(200).json(sanitizeCompletionPayload(result.data));
    }
  } catch (err) {
    if (controller.signal.aborted) return;
    sendError(res, err);
  }
}

module.exports = { runChatAndRespond, sendError, pipeSse };
