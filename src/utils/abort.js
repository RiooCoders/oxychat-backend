'use strict';

/**
 * Gabungin AbortSignal dari luar (mis. client disconnect) dengan timeout internal jadi SATU signal.
 * Sengaja gak pakai AbortSignal.any/AbortSignal.timeout biar tetap jalan di Node 18 (engines >=18).
 *
 *   const t = withTimeout(parentSignal, 5000);
 *   try { await fetch(url, { signal: t.signal }); }
 *   catch (e) { if (t.timedOut) ... }
 *   finally { t.done(); }
 */
function withTimeout(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort(parentSignal.reason);

  if (parentSignal) {
    if (parentSignal.aborted) controller.abort(parentSignal.reason);
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('timeout'));
  }, Math.max(1, timeoutMs));

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    done() {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
    },
  };
}

/**
 * Balapan antara `promise` dan abort `signal`: kalau signal abort duluan, reject dengan makeError().
 * Dipakai buat pekerjaan yang DIBAGI beberapa request (dedupe) — abort satu request gak boleh
 * ngebatalin pekerjaan yang masih dipakai request lain, jadi signal-nya gak dipasang ke pekerjaannya langsung.
 */
function raceAbort(promise, signal, makeError) {
  if (!signal) return promise;
  const err = () => (makeError ? makeError() : new Error('Dibatalkan'));
  if (signal.aborted) return Promise.reject(err());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(err());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      }
    );
  });
}

module.exports = { withTimeout, raceAbort };
