/**
 * Unit tests for lib/gst.js — no database, so this file is fast.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const gst = require('../lib/gst');

test('financial year runs 1 April to 31 March', () => {
  assert.equal(gst.financialYear(new Date('2025-04-01')), '25-26');
  assert.equal(gst.financialYear(new Date('2026-03-31')), '25-26');
  assert.equal(gst.financialYear(new Date('2026-04-01')), '26-27');
  assert.equal(gst.financialYear(new Date('2025-01-15')), '24-25');
});

test('invoice numbers stay within the 16-character, alphanumeric-plus-slash limit', () => {
  const no = gst.formatInvoiceNumber('invoice', '25-26', 1);
  assert.equal(no, 'INV/25-26/00001');
  assert.ok(no.length <= 16, `${no} is ${no.length} characters`);
  assert.match(no, /^[A-Za-z0-9/-]+$/);

  // A five-digit sequence is the practical ceiling before the format needs
  // revisiting — worth knowing the shape holds at that edge.
  assert.equal(gst.formatInvoiceNumber('invoice', '25-26', 99999), 'INV/25-26/99999');
});

test('an unknown document type still produces a usable prefix', () => {
  assert.equal(gst.formatInvoiceNumber('credit_note', '25-26', 3), 'CREDIT_NOTE/25-26/00003');
});

test('a zero GST rate charges nothing, regardless of state', () => {
  assert.deepEqual(gst.computeLineTax('100.00', 0, true), { cgst: '0.00', sgst: '0.00', igst: '0.00' });
  assert.deepEqual(gst.computeLineTax('100.00', 0, false), { cgst: '0.00', sgst: '0.00', igst: '0.00' });
});

test('intra-state tax splits into CGST and SGST at half the rate each', () => {
  const t = gst.computeLineTax('100.00', 18, true);
  assert.equal(t.cgst, '9.00');
  assert.equal(t.sgst, '9.00');
  assert.equal(t.igst, '0.00');
});

test('inter-state tax is all IGST at the full rate', () => {
  const t = gst.computeLineTax('100.00', 18, false);
  assert.equal(t.cgst, '0.00');
  assert.equal(t.sgst, '0.00');
  assert.equal(t.igst, '18.00');
});

test('CGST+SGST is computed at half-rate each, not full tax divided by two', () => {
  // Full tax on 119.98 at 18% is 21.5964 → 21.60. Half that (10.80) would be
  // wrong: each head is its own tax at 9%, not a split of the 18% figure.
  const t = gst.computeLineTax('119.98', 18, true);
  // 119.98 * 0.09 = 10.7982 → 10.80 for each head.
  assert.equal(t.cgst, '10.80');
  assert.equal(t.sgst, '10.80');
  // The two heads can total a paisa different from the full-rate figure —
  // that is expected, not a bug: each is independently exact at its own rate.
  assert.equal(Number(t.cgst) + Number(t.sgst), 21.60);
});

test('an odd rate does not lose a paisa across the CGST/SGST split', () => {
  // Half of 5% is 2.5% — not a round number, so this is the case most likely
  // to reveal a rounding mistake. 333.33 * 2.5% = 8.33325, half-up to 8.33.
  const t = gst.computeLineTax('333.33', 5, true);
  assert.equal(t.cgst, '8.33');
  assert.equal(t.sgst, '8.33');
});

test('round-off to the nearest rupee reports the difference either way', () => {
  const down = gst.roundToRupee('118.35');
  assert.equal(down.total, '118.00');
  assert.equal(down.roundOff, '-0.35');

  const up = gst.roundToRupee('118.64');
  assert.equal(up.total, '119.00');
  assert.equal(up.roundOff, '0.36');

  const exact = gst.roundToRupee('118.00');
  assert.equal(exact.total, '118.00');
  assert.equal(exact.roundOff, '0.00');
});

test('round-off is half-up at the rupee, matching the rest of the app\'s rounding policy', () => {
  const halfway = gst.roundToRupee('118.50');
  assert.equal(halfway.total, '119.00');
  assert.equal(halfway.roundOff, '0.50');
});
