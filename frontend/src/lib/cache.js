/**
 * lib/cache.js — Lightweight in-memory data cache.
 *
 * getCompanies is called independently by Dashboard, Stock, and
 * StockTransactions on every mount. With no cache that is three separate
 * round-trips in a single page-load session even though the data is the same.
 *
 * This module holds one cached result per key with a configurable TTL.
 * After the TTL expires the next read re-fetches and refreshes the cache.
 * A call to `invalidate(key)` clears early — used after a write so the next
 * navigation shows fresh data without waiting for the TTL.
 *
 * Intentionally no React, no Context, no dependency. Plain JS module scope
 * is shared across every component in the bundle.
 */

const CACHE_TTL_MS = 30_000; // 30 seconds

const store = new Map(); // key → { data, expiresAt }

/**
 * Read from cache or call `fetcher()`.
 * @param {string} key
 * @param {() => Promise<any>} fetcher
 * @returns {Promise<any>}
 */
export async function cached(key, fetcher) {
  const entry = store.get(key);
  if (entry && Date.now() < entry.expiresAt) {
    return entry.data;
  }
  const data = await fetcher();
  store.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

/**
 * Remove a cached entry so the next read fetches fresh data.
 * Call this after any write that changes what the cached endpoint returns.
 * @param {string} key
 */
export function invalidate(key) {
  store.delete(key);
}

/** Convenience key — used by every module that fetches companies. */
export const CACHE_COMPANIES = 'companies';
