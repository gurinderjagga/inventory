/**
 * lib/companyAggregates.js
 * Keeps companies.item_count / low_stock_count / stock_value in sync with
 * the items table — recomputed for one company, not incrementally tracked.
 *
 * A delta-based counter (++/-- at every call site) is the more obvious
 * design, but it's also the shape the scalability audit flagged as risky:
 * a bug in any one of the several call sites that touch these numbers would
 * silently drift the stored value away from the truth, with nothing to
 * self-correct it. Recomputing from `items` instead removes that failure
 * mode entirely — there is nothing to drift, only a value that is always
 * either being read or freshly derived — while still being far cheaper than
 * the bug this replaces: that recomputed EVERY company's numbers on every
 * cache miss (up to once every 15s under load); this recomputes ONE
 * company's numbers, scoped by the existing idx_items_company index, only
 * on a write that could actually have changed them.
 */

/**
 * @param {import('pg').PoolClient | {query: Function}} client Must be in the
 *   same transaction as the mutation that changed this company's items, so
 *   the stored aggregate and the row it derives from never observably
 *   disagree to a concurrent reader.
 * @param {number} companyId
 */
async function recomputeCompanyAggregates(client, companyId) {
  await client.query(
    `UPDATE companies c
     SET item_count = agg.item_count,
         low_stock_count = agg.low_stock_count,
         stock_value = agg.stock_value
     FROM (
       SELECT
         COUNT(*)::int AS item_count,
         COALESCE(SUM(CASE WHEN quantity <= low_stock_threshold THEN 1 ELSE 0 END), 0)::int AS low_stock_count,
         COALESCE(SUM(quantity * unit_price), 0) AS stock_value
       FROM items
       WHERE company_id = $1
     ) agg
     WHERE c.id = $1`,
    [companyId]
  );
}

module.exports = { recomputeCompanyAggregates };
