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
 * Dates, in one format everywhere.
 *
 * The dashboard used to render "Aug 30" (en-US) while the tables beside it
 * rendered "30 Aug 2026" (en-IN) — the same records in two formats, one screen
 * apart. Everything goes through here now.
 *
 * @param {string|Date} value
 * @param {{short?: boolean}} [opts]  short omits the year, for dense cells
 * @returns {string} e.g. "30 Aug 2026", or "30 Aug" when short
 */
export function formatDate(value, { short = false } = {}) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    ...(short ? {} : { year: 'numeric' }),
  });
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
