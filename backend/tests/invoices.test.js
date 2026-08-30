const test = require('node:test');
const assert = require('node:assert/strict');

const { setupDatabase, resetData, teardownDatabase, query } = require('./helpers/db');
const { startServer, stopServer, agent } = require('./helpers/client');
const { createUser, createCompany, createItem, createCustomer, stockOf } = require('./helpers/fixtures');
const { lockItemRow, waitForBlockedBackends } = require('./helpers/concurrency');

let a, company, item;

test.before(async () => {
  await setupDatabase();
  await startServer();
});
test.after(async () => {
  await stopServer();
  await teardownDatabase();
});
test.beforeEach(async () => {
  await resetData();
  await createUser('admin');
  a = agent();
  await a.login();
  // GST-registered by default so the many existing tax_rate tests keep working
  // under the new "no tax without a GSTIN" rule — see the dedicated
  // no-GSTIN test below for the unregistered case.
  company = await createCompany('TechCorp Supplies', {
    gstin: '27ABCDE1234F1Z5', legal_name: 'TechCorp Supplies Pvt Ltd', state_code: '27',
  });
  item = await createItem(company.id, { quantity: 10, unit_price: 59.99 });
});

/** The happy path, in one place, since most tests below start from it. */
async function createDraft(overrides = {}) {
  return a.post('/api/invoices', {
    company_id: company.id,
    customer_name: 'Riya Sharma',
    tax_rate: 0,
    line_items: [{ item_id: item.id, quantity: 2, unit_price: 59.99 }],
    ...overrides,
  });
}

test('money and quantity leave the API as numbers, not strings', async () => {
  // The contract the frontend depends on. NUMERIC columns come back from pg as
  // strings by default, and a string leaking through breaks comparison in the
  // client: `"10.000" <= "5.000"` is true, because strings compare
  // lexicographically. db.js overrides the parser; this is what holds it there.
  const draft = await createDraft({ tax_rate: 18 });
  for (const field of ['subtotal', 'total', 'tax_rate']) {
    assert.equal(typeof draft.body[field], 'number', `invoice.${field} should be a number`);
  }

  const detail = await a.get(`/api/invoices/${draft.body.id}`);
  for (const field of ['quantity', 'unit_price', 'line_total']) {
    assert.equal(typeof detail.body.line_items[0][field], 'number',
      `line_items[].${field} should be a number`);
  }

  const items = await a.get(`/api/items/company/${company.id}`);
  for (const field of ['quantity', 'unit_price', 'low_stock_threshold']) {
    assert.equal(typeof items.body[0][field], 'number', `item.${field} should be a number`);
  }

  const stats = await a.get('/api/invoices/summary/stats');
  assert.equal(typeof stats.body.totalRevenue, 'number');
});

test('a draft is created without touching stock', async () => {
  const res = await createDraft();

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'draft');
  assert.match(res.body.invoice_no, /^INV-/);
  assert.equal(Number(res.body.subtotal), 119.98);
  assert.equal(Number(res.body.total), 119.98);
  assert.equal(await stockOf(item.id), 10, 'a draft must not deduct stock');
});

test('tax is applied to the total, rounded to paise', async () => {
  const res = await createDraft({ tax_rate: 18 });

  assert.equal(Number(res.body.subtotal), 119.98);
  // 18% of 119.98 is 21.5964, which rounds half-up to 21.60.
  // Before Phase 1 this was stored raw as 141.5764 — four decimal places in a
  // currency with two. Phase 4 adds GST's round-to-the-nearest-rupee on top.
  assert.equal(Number(res.body.total), 141.58);
});

test('stored amounts never carry more than two decimal places', async () => {
  // A price and quantity chosen to produce a long tail: 1.005 × 3 = 3.015.
  const odd = await createItem(company.id, { name: 'Odd Priced', sku: 'ODD-1', quantity: 100, unit_price: 1.005 });
  const draft = await createDraft({
    tax_rate: 7.5,
    line_items: [{ item_id: odd.id, quantity: 3, unit_price: 1.005 }],
  });

  const { rows } = await query(
    'SELECT subtotal, total FROM invoices WHERE id = $1', [draft.body.id]
  );
  const { rows: lines } = await query(
    'SELECT line_total FROM invoice_line_items WHERE invoice_id = $1', [draft.body.id]
  );

  for (const value of [rows[0].subtotal, rows[0].total, lines[0].line_total]) {
    const decimals = (String(value).split('.')[1] || '').length;
    assert.ok(decimals <= 2, `${value} has ${decimals} decimal places, expected at most 2`);
  }

  // 1.005 × 3 = 3.015 → 3.02 (half-up), + 7.5% = 0.2265 → 0.23, total 3.25.
  assert.equal(Number(lines[0].line_total), 3.02);
  assert.equal(Number(rows[0].total), 3.25);
});

test('the subtotal equals the sum of the line totals shown', async () => {
  // Three lines that each round up: a raw sum would round down to 0.99 while
  // each printed line says 0.34. The invoice has to add up to itself.
  const cheap = await createItem(company.id, { name: 'Fraction', sku: 'FR-1', quantity: 100, unit_price: 0.335 });
  const draft = await createDraft({
    tax_rate: 0,
    line_items: [
      { item_id: cheap.id, quantity: 1, unit_price: 0.335 },
      { item_id: cheap.id, quantity: 1, unit_price: 0.335 },
      { item_id: cheap.id, quantity: 1, unit_price: 0.335 },
    ],
  });

  const detail = await a.get(`/api/invoices/${draft.body.id}`);
  const lineSum = detail.body.line_items.reduce((s, l) => s + Number(l.line_total), 0);

  assert.equal(Number(detail.body.subtotal), 1.02);
  assert.equal(Number(detail.body.subtotal), Number(lineSum.toFixed(2)));
});

test('the line item name comes from the database, not the request', async () => {
  const res = await a.post('/api/invoices', {
    company_id: company.id,
    customer_name: 'Riya Sharma',
    tax_rate: 0,
    line_items: [{ item_id: item.id, item_name: 'Something Else Entirely', quantity: 1, unit_price: 59.99 }],
  });

  const detail = await a.get(`/api/invoices/${res.body.id}`);
  assert.equal(detail.body.line_items[0].item_name, item.name);
});

test('an invoice cannot bill another company\'s stock', async () => {
  const other = await createCompany('Global Electronics');
  const res = await a.post('/api/invoices', {
    company_id: other.id,
    customer_name: 'Riya Sharma',
    tax_rate: 0,
    line_items: [{ item_id: item.id, quantity: 1, unit_price: 10 }],
  });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /No such item/i);
});

test('an invoice needs a company, a customer and at least one line', async () => {
  const noCompany = await a.post('/api/invoices', {
    customer_name: 'X', tax_rate: 0,
    line_items: [{ item_id: item.id, quantity: 1, unit_price: 1 }],
  });
  assert.equal(noCompany.status, 400);

  const noCustomer = await createDraft({ customer_name: '' });
  assert.equal(noCustomer.status, 400);

  const noLines = await createDraft({ line_items: [] });
  assert.equal(noLines.status, 400);
});

test('a zero or negative quantity is refused', async () => {
  for (const quantity of [0, -3]) {
    const res = await createDraft({ line_items: [{ item_id: item.id, quantity, unit_price: 10 }] });
    assert.equal(res.status, 400, `quantity ${quantity} should be refused`);
  }
});

test('finalizing deducts stock and locks the invoice', async () => {
  const draft = await createDraft();

  const res = await a.post(`/api/invoices/${draft.body.id}/finalize`);
  assert.equal(res.status, 200);
  assert.equal(res.body.invoice.status, 'finalized');
  assert.equal(await stockOf(item.id), 8, '10 on hand less 2 billed');
});

test('finalizing twice is refused and stock is deducted only once', async () => {
  const draft = await createDraft();
  await a.post(`/api/invoices/${draft.body.id}/finalize`);

  const again = await a.post(`/api/invoices/${draft.body.id}/finalize`);
  assert.equal(again.status, 409);
  assert.equal(await stockOf(item.id), 8, 'the second finalize must not deduct again');
});

test('two finalize requests racing each other deduct stock once', async () => {
  const draft = await createDraft();

  // Simply firing both at once does not test anything: over a network round
  // trip the second request's status check lands after the first has already
  // committed, so it takes the ordinary "already finalized" path and the test
  // passes even with the row lock removed. Verified by deleting FOR UPDATE —
  // it still passed, three runs out of three.
  //
  // So the interleaving is forced. Holding the item row from the test parks
  // the first request mid-transaction, which lets the second one get past its
  // status check while the first is still uncommitted — precisely the window
  // the lock exists to close.
  const blocker = await lockItemRow(item.id);
  try {
    const first = a.post(`/api/invoices/${draft.body.id}/finalize`);
    await waitForBlockedBackends(1);      // first is parked on the item row

    const second = a.post(`/api/invoices/${draft.body.id}/finalize`);
    await waitForBlockedBackends(2);      // second is parked too, past its read

    await blocker.release();              // both resume, in a known order

    const codes = (await Promise.all([first, second])).map(r => r.status).sort();
    assert.deepEqual(codes, [200, 409], 'exactly one request should win');
    assert.equal(await stockOf(item.id), 8, 'stock must be deducted exactly once');
  } finally {
    await blocker.release();              // no-op if already released
  }
});

test('finalizing beyond available stock is refused and changes nothing', async () => {
  const draft = await createDraft({
    line_items: [{ item_id: item.id, quantity: 25, unit_price: 59.99 }],
  });

  const res = await a.post(`/api/invoices/${draft.body.id}/finalize`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Insufficient stock/i);
  assert.match(res.body.error, /Available: 10/);
  assert.equal(await stockOf(item.id), 10, 'a refused finalize must not move stock');

  const still = await a.get(`/api/invoices/${draft.body.id}`);
  assert.equal(still.body.status, 'draft', 'the invoice must stay editable');
});

test('a partly-fillable invoice rolls back entirely', async () => {
  const second = await createItem(company.id, { name: 'HDMI Cable', sku: 'TC-005', quantity: 1 });
  const draft = await createDraft({
    line_items: [
      { item_id: item.id,   quantity: 2,  unit_price: 59.99 },  // fine
      { item_id: second.id, quantity: 50, unit_price: 10 },     // impossible
    ],
  });

  const res = await a.post(`/api/invoices/${draft.body.id}/finalize`);
  assert.equal(res.status, 409);
  // The transaction is what guarantees this: the first line was deducted
  // before the second failed, so without a rollback stock would read 8.
  assert.equal(await stockOf(item.id), 10, 'the successful line must be rolled back too');
  assert.equal(await stockOf(second.id), 1);
});

test('a draft can be edited, and its totals recomputed', async () => {
  const draft = await createDraft();

  const res = await a.put(`/api/invoices/${draft.body.id}`, {
    customer_name: 'Riya Sharma (edited)',
    tax_rate: 0,
    line_items: [{ item_id: item.id, quantity: 1, unit_price: 59.99 }],
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.customer_name, 'Riya Sharma (edited)');
  assert.equal(Number(res.body.total), 59.99);

  const detail = await a.get(`/api/invoices/${draft.body.id}`);
  assert.equal(detail.body.line_items.length, 1, 'old lines should be replaced, not appended');
  assert.equal(res.body.invoice_no, draft.body.invoice_no, 'editing must not renumber');
});

test('a finalized invoice can be neither edited nor deleted', async () => {
  const draft = await createDraft();
  await a.post(`/api/invoices/${draft.body.id}/finalize`);

  const edit = await a.put(`/api/invoices/${draft.body.id}`, {
    customer_name: 'Nope', tax_rate: 0,
    line_items: [{ item_id: item.id, quantity: 1, unit_price: 1 }],
  });
  assert.equal(edit.status, 409);

  const del = await a.del(`/api/invoices/${draft.body.id}`);
  assert.equal(del.status, 409);
  assert.match(del.body.error, /financial record/i);
});

test('a draft can be deleted, taking its line items with it', async () => {
  const draft = await createDraft();

  const res = await a.del(`/api/invoices/${draft.body.id}`);
  assert.equal(res.status, 200);

  assert.equal((await a.get(`/api/invoices/${draft.body.id}`)).status, 404);
  const { rows } = await query('SELECT * FROM invoice_line_items WHERE invoice_id = $1', [draft.body.id]);
  assert.equal(rows.length, 0);
});

test('an item on an invoice cannot be deleted', async () => {
  const draft = await createDraft();
  await a.post(`/api/invoices/${draft.body.id}/finalize`);

  const res = await a.del(`/api/items/${item.id}`);
  assert.equal(res.status, 409);
  assert.ok(await stockOf(item.id) !== null, 'the item must survive the refusal');
});

test('a company with invoices cannot be deleted', async () => {
  await createDraft();
  const res = await a.del(`/api/companies/${company.id}`);
  assert.equal(res.status, 409);
});

test('dashboard stats count finalized revenue only', async () => {
  const paid = await createDraft();
  await a.post(`/api/invoices/${paid.body.id}/finalize`);
  await createDraft();   // left as a draft

  const res = await a.get('/api/invoices/summary/stats');
  assert.equal(res.status, 200);
  assert.equal(res.body.totalInvoices, 2);
  assert.equal(res.body.draftCount, 1);
  assert.equal(Number(res.body.totalRevenue), 119.98, 'a draft must not count as revenue');
});

test('invoice numbers are unique across a burst of creations', async () => {
  const made = await Promise.all(Array.from({ length: 12 }, () => createDraft()));

  assert.ok(made.every(r => r.status === 201), 'every creation should succeed');
  const numbers = new Set(made.map(r => r.body.invoice_no));
  assert.equal(numbers.size, made.length, 'invoice numbers collided');
});

/* ── Phase 2: customers, supplier snapshot ───────────────────────────────── */

test('an invoice raised against a saved customer picks up its name', async () => {
  const customer = await createCustomer(company.id, { name: 'Riya Sharma', gstin: null });
  const res = await createDraft({ customer_id: customer.id, customer_name: undefined });

  assert.equal(res.status, 201);
  assert.equal(res.body.customer_id, customer.id);
  assert.equal(res.body.customer_name, 'Riya Sharma');
});

test('a customer_name override wins over the saved customer name', async () => {
  const customer = await createCustomer(company.id, { name: 'Riya Sharma' });
  const res = await createDraft({ customer_id: customer.id, customer_name: 'Attn: Accounts' });

  assert.equal(res.body.customer_name, 'Attn: Accounts');
});

test('a customer belonging to another company cannot be billed', async () => {
  const other = await createCompany('Global Electronics');
  const foreignCustomer = await createCustomer(other.id);

  const res = await createDraft({ customer_id: foreignCustomer.id, customer_name: undefined });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /No such customer/i);
});

test('the supplier GSTIN, name, address and state are snapshotted at creation', async () => {
  const res = await createDraft({ tax_rate: 18 });

  assert.equal(res.status, 201);
  assert.equal(res.body.supplier_gstin, '27ABCDE1234F1Z5');
  assert.equal(res.body.supplier_name, 'TechCorp Supplies Pvt Ltd');
  assert.equal(res.body.supplier_state_code, '27');
});

test('the supplier snapshot is frozen even if the company changes afterwards', async () => {
  const draft = await createDraft({ tax_rate: 18 });

  await a.put(`/api/companies/${company.id}`, {
    name: 'TechCorp Supplies', legal_name: 'New Legal Name', state_code: '07',
  });

  const detail = await a.get(`/api/invoices/${draft.body.id}`);
  assert.equal(detail.body.supplier_name, 'TechCorp Supplies Pvt Ltd', 'snapshot must not follow later edits');
  assert.equal(detail.body.supplier_state_code, '27');
});

test('a company with no GSTIN cannot charge tax', async () => {
  const unregistered = await createCompany('Local Traders');
  const unregisteredItem = await createItem(unregistered.id, { quantity: 5, unit_price: 20 });

  const res = await a.post('/api/invoices', {
    company_id: unregistered.id,
    customer_name: 'Riya Sharma',
    tax_rate: 18,
    line_items: [{ item_id: unregisteredItem.id, quantity: 1, unit_price: 20 }],
  });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /GSTIN/i);
});

test('invoice_no can repeat across two different companies', async () => {
  const first = await createDraft();
  const other = await createCompany('Global Electronics');

  // Force the same invoice_no by editing it directly — the API's own generator
  // is randomised, so this tests the constraint change rather than the RNG.
  await query('UPDATE invoices SET invoice_no = $1 WHERE id = $2', ['INV-SHARED-0001', first.body.id]);

  const { rows } = await query(
    `INSERT INTO invoices (invoice_no, company_id, customer_name, subtotal, total)
     VALUES ('INV-SHARED-0001', $1, 'Someone Else', 20, 20) RETURNING id`,
    [other.id]
  );
  assert.ok(rows[0].id, 'a second company should be able to reuse the same invoice_no');
});
