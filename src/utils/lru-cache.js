'use strict';

/** Cache LRU dengan batas TOTAL BYTE (bukan jumlah item). maxBytes <= 0 = cache mati. */
class ByteLruCache {
  constructor(maxBytes) {
    this.maxBytes = Math.max(0, Number(maxBytes) || 0);
    this.bytes = 0;
    this.map = new Map(); // urutan insert = urutan pemakaian (paling lama di depan)
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, size) {
    if (this.maxBytes <= 0 || !(size > 0) || size > this.maxBytes) return false;
    const prev = this.map.get(key);
    if (prev) {
      this.bytes -= prev.size;
      this.map.delete(key);
    }
    this.map.set(key, { value, size });
    this.bytes += size;
    while (this.bytes > this.maxBytes && this.map.size > 0) {
      const oldestKey = this.map.keys().next().value;
      this.bytes -= this.map.get(oldestKey).size;
      this.map.delete(oldestKey);
    }
    return true;
  }

  clear() {
    this.map.clear();
    this.bytes = 0;
  }

  get size() {
    return this.map.size;
  }
}

module.exports = { ByteLruCache };
