/**
 * lib/keysetCursor.js — opaque cursors for keyset (seek) pagination.
 *
 * OFFSET pagination can't randomly-access row N of a sorted result: for
 * `OFFSET k`, Postgres has to walk and discard all `k` preceding matching
 * rows before it can emit the LIMIT window — even with a covering index, that
 * cost grows with how deep into the table the page is. On an append-only
 * ledger (stock_movements, invoices) that "depth" only ever increases, so the
 * same page gets slower every month on its own, independent of traffic.
 *
 * Keyset pagination instead remembers *where the last page ended*
 * (created_at, id) and asks for rows strictly after that point — an index
 * range scan starting at the cursor, cost proportional to page size
 * regardless of how deep the page is.
 *
 * The cursor is opaque to callers on purpose: it's base64 JSON today, but
 * callers must never construct or inspect one themselves — that's what
 * keeps this free to change later (a different encoding, additional fields)
 * without it being a breaking API change.
 */

/** @param {{createdAt: string|Date, id: number}} seek */
function encodeCursor(seek) {
  const createdAt = seek.createdAt instanceof Date ? seek.createdAt.toISOString() : seek.createdAt;
  return Buffer.from(JSON.stringify({ createdAt, id: seek.id }), 'utf8').toString('base64url');
}

/**
 * @param {string|undefined} raw
 * @returns {{createdAt: string, id: number}|null} null if absent — "start from the beginning"
 * @throws {Error} if present but malformed, so a tampered/corrupt cursor fails
 *   loudly as a 400 rather than silently returning the wrong slice of data.
 */
function decodeCursor(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid pagination cursor');
  }
  if (typeof parsed?.createdAt !== 'string' || !Number.isInteger(parsed?.id)) {
    throw new Error('Invalid pagination cursor');
  }
  return parsed;
}

module.exports = { encodeCursor, decodeCursor };
