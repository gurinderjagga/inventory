/**
 * lib/money.js — exact decimal arithmetic and the rounding policy.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Every monetary column used to be DOUBLE PRECISION, and every total was
 * computed with JavaScript's `*` and `+`. Both are binary floating point, which
 * cannot represent most decimal fractions: `3 * 59.99` is 179.97000000000003,
 * and `0.1 + 0.2` is 0.30000000000000004. Displayed through a 2-decimal
 * formatter that looks correct, so the drift is invisible until it accumulates
 * in a SUM() over a year of invoices, or until a GST return disagrees with the
 * invoice it was built from.
 *
 * Storage is now NUMERIC. This module is the other half: arithmetic that is
 * exact all the way through, and one place where rounding is decided.
 *
 * ── The policy ───────────────────────────────────────────────────────────────
 * 1. Money is carried to 2 decimal places (paise).
 * 2. Rounding is HALF-UP — 0.125 becomes 0.13, never 0.12. This is the ordinary
 *    Indian commercial convention, and what an accountant checking the
 *    arithmetic by hand will do. It is NOT banker's rounding.
 * 3. Rounding happens as late as possible: a line total is rounded once, and the
 *    subtotal is the sum of those rounded line totals — not a rounded sum of
 *    unrounded ones. Those two differ, and invoice lines have to add up to the
 *    total printed beneath them or the document is indefensible.
 * 4. Quantities carry 3 decimal places, for units sold by weight or volume.
 *
 * Phase 4 adds GST's own rule on top: the invoice total is rounded to the
 * nearest rupee with the difference shown on an explicit round-off line. That
 * belongs with the tax engine, not here — this module gives it exact inputs.
 */
const Decimal = require('decimal.js');

const MONEY_DP = 2;   // paise
const QTY_DP   = 3;   // grams, millilitres

// Configured once for the process. HALF_UP is policy point 2; the precision is
// far beyond any invoice and only bounds intermediate division.
Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

/**
 * Coerce anything the database or a request body might hand us into a Decimal.
 *
 * `pg` returns NUMERIC columns as strings to avoid the very precision loss this
 * module exists to prevent, so string input is the normal case, not the edge.
 *
 * @param {number|string|Decimal|null|undefined} value
 * @returns {Decimal} zero for anything unparseable, so a missing optional
 *   amount behaves like nothing rather than poisoning a total with NaN
 */
function dec(value) {
  if (value instanceof Decimal) return value;
  if (value === null || value === undefined || value === '') return new Decimal(0);
  try {
    const d = new Decimal(value);
    return d.isFinite() ? d : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

/** Round to paise, half-up, and return a string safe to store in NUMERIC. */
function money(value) {
  return dec(value).toDecimalPlaces(MONEY_DP, Decimal.ROUND_HALF_UP).toFixed(MONEY_DP);
}

/** Round to the quantity scale and return a string safe to store in NUMERIC. */
function quantity(value) {
  return dec(value).toDecimalPlaces(QTY_DP, Decimal.ROUND_HALF_UP).toFixed(QTY_DP);
}

/**
 * A line's money value: quantity × unit price, rounded once.
 *
 * Rounded here rather than left raw, per policy point 3 — this is the figure
 * printed on the line, so it is the figure that must be summed.
 */
function lineTotal(qty, unitPrice) {
  return money(dec(qty).times(dec(unitPrice)));
}

/** Sum a list of amounts exactly. Inputs may be strings, numbers or Decimals. */
function sum(values) {
  return money(values.reduce((acc, v) => acc.plus(dec(v)), new Decimal(0)));
}

/**
 * Tax on an amount at a percentage rate.
 * Kept separate from `total` so Phase 4 can apply it per line and per tax head.
 */
function taxOn(amount, ratePercent) {
  return money(dec(amount).times(dec(ratePercent)).dividedBy(100));
}

/**
 * True when two amounts are equal to the paise.
 * `===` on strings would call "10.00" and "10.000" different, and `==` on
 * numbers reintroduces the float comparison this module exists to avoid.
 */
function equal(a, b) {
  return dec(a).toDecimalPlaces(MONEY_DP).equals(dec(b).toDecimalPlaces(MONEY_DP));
}

/** Compare as decimals: -1, 0 or 1. */
function compare(a, b) {
  return dec(a).comparedTo(dec(b));
}

/** True when `a` is at least `b` — the stock-sufficiency question. */
function atLeast(a, b) {
  return dec(a).greaterThanOrEqualTo(dec(b));
}

module.exports = {
  Decimal, dec,
  money, quantity, lineTotal, sum, taxOn,
  equal, compare, atLeast,
  MONEY_DP, QTY_DP,
};
