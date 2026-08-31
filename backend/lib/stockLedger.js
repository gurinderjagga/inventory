/**
 * lib/stockLedger.js
 * The one place every stock-quantity mutation goes through.
 *
 * `items.quantity` is a maintained cache of `SUM(stock_movements.quantity_delta)`
 * for that item — never write to it directly. `applyMovement` updates the
 * cache and appends the ledger row atomically, in the caller's own
 * transaction, so the two can never drift apart.
 *
 * The guard clause (`quantity + delta >= 0`) is a generalisation of the
 * pre-Phase-3 finalize guard (`quantity >= amount`, for a fixed deduction) —
 * restated for a signed delta so the same statement covers stock going out
 * (finalize) and coming in (reversal, goods receipt, a positive adjustment).
 * It is still a single `UPDATE ... WHERE ...` touching the item row, so the
 * row-level locking the finalize concurrency test depends on
 * (tests/helpers/concurrency.js) is unchanged.
 */
const { ConflictError } = require('./errors');
const money = require('./money');

/**
 * @param {import('pg').PoolClient} client  Must be inside a transaction.
 * @param {object} opts
 * @param {number} opts.itemId
 * @param {number} opts.companyId
 * @param {number|string} opts.delta       Signed quantity change.
 * @param {string} opts.reason             One of the stock_movements_reason_ck values.
 * @param {number} [opts.invoiceId]
 * @param {string} [opts.note]
 * @param {number} [opts.userId]
 * @returns {Promise<string|null>} the item's new quantity, or null if delta was zero (no-op, no row written)
 * @throws {ConflictError} if the delta would take quantity below zero
 */
async function applyMovement(client, { itemId, companyId, delta, reason, invoiceId, note, userId }) {
  const qtyDelta = money.quantity(delta);
  if (money.dec(qtyDelta).isZero()) return null;   // nothing changed, nothing to log

  const { rows } = await client.query(
    `UPDATE items
     SET quantity = quantity + $1, updated_at = now()
     WHERE id = $2 AND quantity + $1 >= 0
     RETURNING quantity, name`,
    [qtyDelta, itemId]
  );

  if (!rows[0]) {
    const { rows: current } = await client.query(
      'SELECT name, quantity FROM items WHERE id = $1', [itemId]
    );
    const item = current[0];
    throw new ConflictError(
      `Insufficient stock for "${item?.name || 'unknown item'}". ` +
      `Available: ${item ? item.quantity : 0}, Requested: ${money.dec(qtyDelta).abs()}`
    );
  }

  await client.query(
    `INSERT INTO stock_movements
       (item_id, company_id, quantity_delta, reason, invoice_id, note, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [itemId, companyId, qtyDelta, reason, invoiceId ?? null, note ?? null, userId ?? null]
  );

  return rows[0].quantity;
}

/**
 * Bulk version of applyMovement, for the several-distinct-items-at-once case
 * an invoice finalize/reverse is (the old code called applyMovement once per
 * line — 2 round trips per line). A single client only ever runs one query
 * at a time regardless of how it's awaited — `Promise.all` on one connection
 * doesn't parallelize, node-postgres just queues it — so the only real win
 * available inside a transaction is fewer statements, not concurrent ones.
 *
 * Two lines billing the SAME item are summed into a single net delta before
 * the UPDATE: a multi-row `UPDATE ... FROM` only applies one matching source
 * row per target row, so without this, one of two lines on the same item
 * would silently have no effect on `items.quantity`. Each line still gets
 * its own `stock_movements` row afterward — the audit granularity
 * `applyMovement` always had is unchanged, only the item-quantity update is
 * netted.
 *
 * @param {import('pg').PoolClient} client
 * @param {Array<{itemId: number, companyId: number, delta: number|string, reason: string, invoiceId?: number, note?: string, userId?: number}>} entries
 * @returns {Promise<void>}
 * @throws {ConflictError} naming every item without enough stock, if any
 */
async function applyMovements(client, entries) {
  const withDelta = entries
    .map((e) => ({ ...e, qtyDelta: money.quantity(e.delta) }))
    .filter((e) => !money.dec(e.qtyDelta).isZero());
  if (withDelta.length === 0) return;

  const netByItem = new Map(); // itemId -> Decimal, summed across every line on that item
  for (const e of withDelta) {
    netByItem.set(e.itemId, (netByItem.get(e.itemId) ?? money.dec(0)).plus(money.dec(e.qtyDelta)));
  }
  const itemIds   = [...netByItem.keys()];
  const netDeltas = itemIds.map((id) => netByItem.get(id).toString());

  const { rows: updated } = await client.query(
    `UPDATE items
     SET quantity = items.quantity + v.delta, updated_at = now()
     FROM (SELECT * FROM unnest($1::int[], $2::numeric[]) AS t(item_id, delta)) AS v
     WHERE items.id = v.item_id AND items.quantity + v.delta >= 0
     RETURNING items.id`,
    [itemIds, netDeltas]
  );
  const updatedIds = new Set(updated.map((r) => r.id));
  const failedIds  = itemIds.filter((id) => !updatedIds.has(id));

  if (failedIds.length > 0) {
    const { rows: failedItems } = await client.query(
      'SELECT id, name, quantity FROM items WHERE id = ANY($1)',
      [failedIds]
    );
    const details = failedIds.map((id) => {
      const item = failedItems.find((r) => r.id === id);
      return `"${item?.name || 'unknown item'}" (available: ${item ? item.quantity : 0}, requested: ${netByItem.get(id).abs()})`;
    });
    throw new ConflictError(`Insufficient stock for ${details.join(', ')}`);
  }

  await client.query(
    `INSERT INTO stock_movements (item_id, company_id, quantity_delta, reason, invoice_id, note, user_id)
     SELECT * FROM unnest($1::int[], $2::int[], $3::numeric[], $4::text[], $5::int[], $6::text[], $7::int[])`,
    [
      withDelta.map((e) => e.itemId),
      withDelta.map((e) => e.companyId),
      withDelta.map((e) => e.qtyDelta),
      withDelta.map((e) => e.reason),
      withDelta.map((e) => e.invoiceId ?? null),
      withDelta.map((e) => e.note ?? null),
      withDelta.map((e) => e.userId ?? null),
    ]
  );
}

module.exports = { applyMovement, applyMovements };
