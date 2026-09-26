/**
 * Small in-memory TTL cache with a hard size cap (oldest entry evicted first),
 * so random lookups (e.g. made-up slugs) can't grow memory without bound.
 * A stored value of `null` means "known not to exist".
 */
export class TtlCache {
  #map = new Map();
  #ttlMs;
  #maxEntries;
  #now;

  constructor({ ttlMs, maxEntries = 10_000, now = () => Date.now() }) {
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
    this.#now = now;
  }

  get(key) {
    const entry = this.#map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs = this.#ttlMs) {
    if (this.#map.has(key)) {
      this.#map.delete(key);
    } else if (this.#map.size >= this.#maxEntries) {
      this.#map.delete(this.#map.keys().next().value);
    }
    this.#map.set(key, { value, expiresAt: this.#now() + ttlMs });
  }

  delete(key) {
    this.#map.delete(key);
  }

  /** Iterates raw entries, including expired ones. */
  *entries() {
    for (const [key, entry] of this.#map) yield [key, entry.value];
  }

  clear() {
    this.#map.clear();
  }

  get size() {
    return this.#map.size;
  }
}
