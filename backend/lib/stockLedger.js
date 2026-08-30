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
 * @param {number} [opts.goodsReceiptId]
 * @param {string} [opts.note]
 * @param {number} [opts.userId]
 * @returns {Promise<string|null>} the item's new quantity, or null if delta was zero (no-op, no row written)
 * @throws {ConflictError} if the delta would take quantity below zero
 */
async function applyMovement(client, { itemId, companyId, delta, reason, invoiceId, goodsReceiptId, note, userId }) {
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
       (item_id, company_id, quantity_delta, reason, invoice_id, goods_receipt_id, note, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [itemId, companyId, qtyDelta, reason, invoiceId ?? null, goodsReceiptId ?? null, note ?? null, userId ?? null]
  );

  return rows[0].quantity;
}

module.exports = { applyMovement };
