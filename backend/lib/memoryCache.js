/**
 * lib/memoryCache.js — a tiny in-process TTL cache.
 *
 * Neon is a network hop away (~90-150ms per round trip, measured directly —
 * see the latency audit), so a query that's identical to one made moments
 * ago is pure waste if the answer can't have changed yet. This exists for
 * read-heavy, low-cardinality, rarely-changing data — a per-company feature
 * flag, an aggregate list — not as a general-purpose cache.
 *
 * Deliberately process-local: this app runs as one Node process per
 * deployment today. A multi-instance deployment would need a shared cache
 * (Redis) instead, since each instance would otherwise serve a different
 * answer until every instance's TTL independently expires.
 */

const store = new Map(); // key -> { value, expiresAt }

/** @returns {*} the cached value, or undefined if absent or expired. */
function get(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

function set(key, value, ttlMs) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Evict one key immediately — used after a write so the next read isn't stale. */
function del(key) {
  store.delete(key);
}

/** Evict every key starting with `prefix` — for caches keyed by a scope that a single write can invalidate broadly. */
function delPrefix(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/** Clears everything — test isolation only. */
function clear() {
  store.clear();
}

module.exports = { get, set, del, delPrefix, clear };
