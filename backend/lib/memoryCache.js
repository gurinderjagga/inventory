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

// Fetches currently in flight, keyed the same as `store`. Without this, every
// request that arrives between a TTL expiry and the first request's query
// resolving independently repeats that same query — on the busiest endpoint
// in the app, a 15s cache window closing under real concurrent load means
// dozens of requests hit Neon with the identical question at once, not one.
const inflight = new Map(); // key -> Promise

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

/**
 * Read-through cache with single-flight coalescing: on a miss, the first
 * caller runs `fetchFn` and every concurrent caller for the same key awaits
 * that same in-flight promise instead of starting a duplicate query.
 *
 * A write racing an in-flight fetch (a `del()` landing between this fetch
 * starting and it resolving) can still let a stale value get cached — the
 * same tradeoff the plain cache-aside pattern already had before this
 * existed, bounded by `ttlMs` either way. This only removes the *duplicate
 * concurrent query* problem, not that pre-existing, already-accepted one.
 *
 * @param {string} key
 * @param {number} ttlMs
 * @param {() => Promise<*>} fetchFn
 * @returns {Promise<*>}
 */
async function getOrFetch(key, ttlMs, fetchFn) {
  const cached = get(key);
  if (cached !== undefined) return cached;

  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const value = await fetchFn();
      set(key, value, ttlMs);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/** Clears everything — test isolation only. */
function clear() {
  store.clear();
  inflight.clear();
}

module.exports = { get, set, del, delPrefix, getOrFetch, clear };
