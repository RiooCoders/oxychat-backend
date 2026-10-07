'use strict';

/**
 * Semaphore sederhana dengan antrean + batas waktu tunggu + dukungan AbortSignal.
 * Dipakai buat menjaga jumlah request paralel ke ElevenLabs (paket gratis: maks 2 sekaligus).
 *   const release = await sem.acquire({ timeoutMs, signal });
 *   try { ... } finally { release(); }
 * acquire() menolak dengan Error ber-`code`: 'QUEUE_TIMEOUT' | 'ABORTED'.
 */
function createSemaphore(max) {
  const limit = Math.max(1, Number(max) || 1);
  let active = 0;
  const queue = [];

  function makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      drain();
    };
  }

  function drain() {
    while (queue.length > 0 && active < limit) {
      const waiter = queue.shift();
      waiter.cleanup();
      active += 1;
      waiter.resolve(makeRelease());
    }
  }

  function coded(message, code) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  function acquire({ timeoutMs = 15000, signal } = {}) {
    if (signal && signal.aborted) return Promise.reject(coded('aborted', 'ABORTED'));
    if (active < limit && queue.length === 0) {
      active += 1;
      return Promise.resolve(makeRelease());
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve };
      const remove = () => {
        const i = queue.indexOf(waiter);
        if (i >= 0) queue.splice(i, 1);
      };
      const onAbort = () => {
        waiter.cleanup();
        remove();
        reject(coded('aborted', 'ABORTED'));
      };
      const timer = setTimeout(() => {
        waiter.cleanup();
        remove();
        reject(coded('queue timeout', 'QUEUE_TIMEOUT'));
      }, Math.max(1, timeoutMs));
      waiter.cleanup = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      queue.push(waiter);
    });
  }

  return {
    acquire,
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
  };
}

module.exports = { createSemaphore };
