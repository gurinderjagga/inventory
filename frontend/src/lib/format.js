/**
 * Formatting helpers.
 *
 * Currency goes through Intl rather than string concatenation so amounts get
 * Indian digit grouping — ₹12,34,567.89 (lakhs), not ₹1,234,567.89. Swapping
 * the symbol alone would have produced correct-looking but wrongly grouped
 * figures on anything above six digits.
 */

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Format a value as rupees. Accepts numbers or numeric strings, since
 * DOUBLE PRECISION columns can arrive either way.
 * @param {number|string} value
 * @returns {string} e.g. "₹1,234.56"
 */
export function formatCurrency(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return INR.format(Number.isFinite(n) ? n : 0);
}

/**
 * Rupees with no paise — for dense card stats where two decimals are noise.
 * @param {number|string} value
 * @returns {string} e.g. "₹1,235"
 */
export function formatCurrencyShort(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(Number.isFinite(n) ? n : 0);
}
