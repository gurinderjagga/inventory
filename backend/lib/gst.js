/**
 * lib/gst.js — pure GST tax-engine primitives.
 *
 * No DB, no Express — mirrors the precedent lib/money.js and lib/stockLedger.js
 * already set: the arithmetic and formatting rules live in one small, directly
 * testable place, and routes/invoices.js orchestrates them against real data
 * (which company, which customer, which items).
 */
const { Decimal, dec, money, taxOn } = require('./money');

const FY_START_MONTH = 4;   // April — India's financial year runs 1 Apr–31 Mar

/**
 * The financial year a date falls in, as GST returns and invoice series both
 * key off it — `'25-26'` for any date from 2025-04-01 through 2026-03-31.
 * @param {Date} [date]
 * @returns {string}
 */
function financialYear(date = new Date()) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;   // 1–12
  const startYear = m >= FY_START_MONTH ? y : y - 1;
  const startYY = String(startYear).slice(-2);
  const endYY   = String((startYear + 1) % 100).padStart(2, '0');
  return `${startYY}-${endYY}`;
}

const DOCUMENT_PREFIXES = { invoice: 'INV' };

/**
 * A sequential document number: prefix / financial year / zero-padded
 * sequence — e.g. `INV/25-26/00001`. Stays within the 16-character,
 * alphanumeric-plus-`/`-and-`-` limit invoice numbers are held to.
 * @param {string} documentType  One of DOCUMENT_PREFIXES' keys.
 * @param {string} fy            From financialYear().
 * @param {number} seq           The allocated counter value.
 */
function formatInvoiceNumber(documentType, fy, seq) {
  const prefix = DOCUMENT_PREFIXES[documentType] || documentType.toUpperCase();
  return `${prefix}/${fy}/${String(seq).padStart(5, '0')}`;
}

/**
 * A line's tax, split by place of supply.
 *
 * Intra-state computes CGST and SGST independently at half the rate each —
 * not "compute the full-rate tax, then divide by two". The latter can land a
 * paisa off on an odd amount (half of ₹10.01 is ₹5.005, which rounds to
 * ₹5.01, and twice that is ₹10.02 ≠ ₹10.01); computing each head at its own
 * half-rate from the taxable value is what GST software and manual invoicing
 * both actually do, and it doesn't have that problem.
 *
 * @param {number|string} taxableValue  The line's pre-tax amount.
 * @param {number|string} gstRate       The item's own GST rate, as a percentage.
 * @param {boolean} intraState          Same state as the supplier, or not.
 * @returns {{cgst: string, sgst: string, igst: string}}
 */
function computeLineTax(taxableValue, gstRate, intraState) {
  if (dec(gstRate).isZero()) {
    return { cgst: '0.00', sgst: '0.00', igst: '0.00' };
  }
  if (intraState) {
    const halfRate = dec(gstRate).dividedBy(2);
    return {
      cgst: taxOn(taxableValue, halfRate),
      sgst: taxOn(taxableValue, halfRate),
      igst: '0.00',
    };
  }
  return { cgst: '0.00', sgst: '0.00', igst: taxOn(taxableValue, gstRate) };
}

/**
 * Round an invoice's pre-round total to the nearest whole rupee, half-up, and
 * report the difference as an explicit round-off line — the Indian GST
 * convention, rather than leaving the total exact to the paisa.
 * @param {number|string} preRoundTotal
 * @returns {{total: string, roundOff: string}} total has no decimal places
 *   (still a money()-shaped 2dp string, e.g. "118.00"); roundOff may be
 *   negative (rounded down) or positive (rounded up).
 */
function roundToRupee(preRoundTotal) {
  const pre = dec(preRoundTotal);
  const rounded = pre.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return {
    total: money(rounded),
    roundOff: money(rounded.minus(pre)),
  };
}

module.exports = {
  financialYear, formatInvoiceNumber, computeLineTax, roundToRupee,
};
