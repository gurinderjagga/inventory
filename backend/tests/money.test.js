/**
 * Unit tests for lib/money.js — no database, so this file is fast.
 *
 * These are the cases that motivated the whole phase: each `assert` below is a
 * value the old floating-point arithmetic got wrong.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const money = require('../lib/money');

test('the classic float failures produce exact results', () => {
  // 0.1 + 0.2 === 0.30000000000000004 in JavaScript.
  assert.equal(money.sum([0.1, 0.2]), '0.30');

  // 3 * 59.99 === 179.97000000000003.
  assert.equal(money.lineTotal(3, 59.99), '179.97');

  // 1.005 * 100 === 100.49999999999999, so naive rounding gives 100.49.
  assert.equal(money.money(1.005 * 100), '100.50');
});

test('amounts are carried to exactly two decimal places', () => {
  assert.equal(money.money(5), '5.00');
  assert.equal(money.money('5.1'), '5.10');
  assert.equal(money.money(0), '0.00');
});

test('rounding is half-up, not banker\'s', () => {
  // Banker's rounding would give 0.12 here — an accountant checking by hand
  // will not.
  assert.equal(money.money('0.125'), '0.13');
  assert.equal(money.money('0.135'), '0.14');
  assert.equal(money.money('0.145'), '0.15');
});

test('quantities carry three decimal places for weight and volume', () => {
  assert.equal(money.quantity(2), '2.000');
  assert.equal(money.quantity('1.5'), '1.500');
  assert.equal(money.quantity('0.3333'), '0.333');
});

test('a subtotal is the sum of rounded line totals, not a rounded raw sum', () => {
  // Three lines that each round up. Summing raw then rounding gives 0.99;
  // summing the rounded lines gives 1.02 — and 1.02 is what the invoice shows,
  // because each line prints 0.34.
  const lines = [
    money.lineTotal(1, '0.335'),
    money.lineTotal(1, '0.335'),
    money.lineTotal(1, '0.335'),
  ];
  assert.deepEqual(lines, ['0.34', '0.34', '0.34']);
  assert.equal(money.sum(lines), '1.02');
});

test('tax is computed exactly', () => {
  assert.equal(money.taxOn('100.00', 18), '18.00');
  assert.equal(money.taxOn('119.98', 18), '21.60');   // 21.5964
  assert.equal(money.taxOn('100.00', '0.25'), '0.25');
  assert.equal(money.taxOn('100.00', 0), '0.00');
});

test('strings from the database are handled like numbers', () => {
  // pg hands back NUMERIC as a string when the parser is not overridden, and
  // request bodies may carry either.
  assert.equal(money.lineTotal('2.000', '59.99'), '119.98');
  assert.equal(money.sum(['1.10', 2.2, '3.30']), '6.60');
});

test('missing and malformed amounts count as zero rather than poisoning a total', () => {
  assert.equal(money.money(null), '0.00');
  assert.equal(money.money(undefined), '0.00');
  assert.equal(money.money(''), '0.00');
  assert.equal(money.money('not a number'), '0.00');
  assert.equal(money.money(NaN), '0.00');
  assert.equal(money.money(Infinity), '0.00');
  // One bad line must not turn the whole invoice into NaN.
  assert.equal(money.sum(['10.00', null, '5.00']), '15.00');
});

test('comparison is decimal, not lexicographic and not float', () => {
  // The bug this prevents: "10.000" <= "5.000" is TRUE for JavaScript strings.
  assert.equal(money.compare('10.000', '5.000'), 1);
  assert.equal(money.atLeast('10.000', '5.000'), true);
  assert.equal(money.atLeast('5.000', '10.000'), false);

  assert.equal(money.atLeast('2.000', '2.000'), true, 'exactly enough stock is enough');
  assert.equal(money.atLeast('1.999', '2.000'), false);

  assert.equal(money.equal('10.00', '10.000'), true, 'scale should not affect equality');
  assert.equal(money.equal(0.1 + 0.2, '0.30'), true, 'float drift should compare equal at 2dp');
});

test('large amounts stay exact', () => {
  // The upper end of NUMERIC(14,2), where a double would start to slip.
  assert.equal(money.sum(['999999999999.99', '0.01']), '1000000000000.00');
  assert.equal(money.lineTotal('1000000', '999.99'), '999990000.00');
});

test('a realistic GST-shaped invoice adds up', () => {
  const lines = [
    { qty: '3.000', price: '59.99' },     // 179.97
    { qty: '1.500', price: '249.50' },    // 374.25
    { qty: '12.000', price: '8.33' },     // 99.96
  ];
  const lineTotals = lines.map(l => money.lineTotal(l.qty, l.price));
  assert.deepEqual(lineTotals, ['179.97', '374.25', '99.96']);

  const subtotal = money.sum(lineTotals);
  assert.equal(subtotal, '654.18');

  const tax = money.taxOn(subtotal, 18);
  assert.equal(tax, '117.75');            // 117.7524

  assert.equal(money.sum([subtotal, tax]), '771.93');
});
