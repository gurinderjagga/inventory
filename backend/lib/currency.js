/**
 * lib/currency.js — amount formatting for generated PDFs.
 */

// en-IN grouping: 12,34,567.89 (lakhs), not 1,234,567.89.
const IN_NUMBER = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Format an amount for the invoice PDF.
 *
 * Deliberately "Rs." and not the ₹ symbol. pdfkit's built-in fonts (Helvetica
 * and the other 13 standard PDF fonts) are WinAnsi-encoded and contain no
 * rupee glyph: U+20B9 silently encodes to byte 0xB9, which WinAnsi maps to
 * SUPERSCRIPT ONE. The PDF would render "¹1,234.56" — wrong, and wrong quietly,
 * since nothing throws.
 *
 * To print the real ₹ symbol, embed a Unicode TTF that has the glyph
 * (Noto Sans and DejaVu Sans both do) and register it with doc.registerFont().
 * "Rs." is standard notation on Indian invoices, so this is a correct rendering
 * rather than a degraded one.
 *
 * @param {number|string} value
 * @returns {string} e.g. "Rs. 1,234.56"
 */
function formatAmount(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return `Rs. ${IN_NUMBER.format(Number.isFinite(n) ? n : 0)}`;
}

module.exports = { formatAmount };
