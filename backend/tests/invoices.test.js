const test = require('node:test');
const assert = require('node:assert/strict');

const { setupDatabase, resetData, teardownDatabase, query } = require('./helpers/db');
const { startServer, stopServer, agent } = require('./helpers/client');
const { createUser, createCompany, createItem, createCustomer, stockOf } = require('./helpers/fixtures');
const { lockItemRow, waitForBlockedBackends } = require('./helpers/concurrency');

let a, company, item, customer;

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
  // GST-registered by default so the supplier-snapshot tests keep working;
  // the item's own gst_rate defaults to 0, so this does not by itself cause
  // any of the tax-engine's CGST/SGST/IGST or rounding behaviour to kick in —
  // see the dedicated tax-engine tests below for that. A saved customer with
  // a matching state is required regardless, once a company is registered on
  // the regular scheme: the tax engine won't bill a manual-entry name.
  company = await createCompany('TechCorp Supplies', {
    gstin: '27ABCDE1234F1Z5', legal_name: 'TechCorp Supplies Pvt Ltd', state_code: '27',
  });
  item = await createItem(company.id, { quantity: 10, unit_price: 59.99 });
  customer = await createCustomer(company.id, { name: 'Riya Sharma', state_code: '27' });
});

/** The happy path, in one place, since most tests below start from it. */
async function createDraft(overrides = {}) {
  return a.post('/api/invoices', {
    company_id: company.id,
    customer_id: customer.id,
    line_items: [{ item_id: item.id, quantity: 2, unit_price: 59.99 }],
    ...overrides,
  });
}

test('money and quantity leave the API as numbers, not strings', async () => {
  // The contract the frontend depends on. NUMERIC columns come back from pg as
  // strings by default, and a string leaking through breaks comparison in the
  // client: `"10.000" <= "5.000"` is true, because strings compare
  // lexicographically. db.js overrides the parser; this is what holds it there.
  const taxed = await createItem(company.id, { name: 'Taxed Widget', sku: 'TAX-1', quantity: 10, unit_price: 59.99, gst_rate: 18 });
  const draft = await createDraft({ line_items: [{ item_id: taxed.id, quantity: 2, unit_price: 59.99 }] });
  for (const field of ['subtotal', 'cgst_total', 'sgst_total', 'igst_total', 'round_off', 'total']) {
    assert.equal(typeof draft.body[field], 'number', `invoice.${field} should be a number`);
  }

  const detail = await a.get(`/api/invoices/${draft.body.id}`);
  for (const field of ['quantity', 'unit_price', 'line_total', 'gst_rate', 'cgst_amount', 'sgst_amount', 'igst_amount']) {
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
  // The default item's gst_rate is 0, so there is no actual tax to round
  // around — the total stays exact to the paisa.
  assert.equal(Number(res.body.total), 119.98);
  assert.equal(await stockOf(item.id), 10, 'a draft must not deduct stock');
});

test('CGST and SGST are computed per line and the total rounds to the nearest rupee (same state)', async () => {
  const taxed = await createItem(company.id, { name: 'Taxed Widget', sku: 'TAX-2', quantity: 10, unit_price: 59.99, gst_rate: 18 });
  const res = await createDraft({ line_items: [{ item_id: taxed.id, quantity: 2, unit_price: 59.99 }] });

  assert.equal(Number(res.body.subtotal), 119.98);
  // 18% split into 9% CGST + 9% SGST, each independently rounded:
  // 119.98 * 0.09 = 10.7982 -> 10.80. The customer fixture shares the
  // company's state ('27'), so this is intra-state.
  assert.equal(Number(res.body.cgst_total), 10.80);
  assert.equal(Number(res.body.sgst_total), 10.80);
  assert.equal(Number(res.body.igst_total), 0);
  // 119.98 + 10.80 + 10.80 = 141.58, rounds half-up to the nearest rupee.
  assert.equal(Number(res.body.total), 142);
  assert.equal(Number(res.body.round_off), 0.42);
});

test('IGST is charged in full when the customer is in a different state', async () => {
  const outOfState = await createCustomer(company.id, { name: 'Out of State Co', state_code: '07' });
  const taxed = await createItem(company.id, { name: 'Taxed Widget', sku: 'TAX-3', quantity: 10, unit_price: 59.99, gst_rate: 18 });

  const res = await createDraft({
    customer_id: outOfState.id,
    line_items: [{ item_id: taxed.id, quantity: 2, unit_price: 59.99 }],
  });

  assert.equal(Number(res.body.cgst_total), 0);
  assert.equal(Number(res.body.sgst_total), 0);
  assert.equal(Number(res.body.igst_total), 21.60);   // 119.98 * 0.18 = 21.5964 -> 21.60
  assert.equal(res.body.place_of_supply_state, '07');
});

test('stored amounts never carry more than two decimal places', async () => {
  // A price and quantity chosen to produce a long tail: 1.005 × 3 = 3.015.
  const odd = await createItem(company.id, { name: 'Odd Priced', sku: 'ODD-1', quantity: 100, unit_price: 1.005, gst_rate: 7.5 });
  const draft = await createDraft({
    line_items: [{ item_id: odd.id, quantity: 3, unit_price: 1.005 }],
  });

  const { rows } = await query(
    'SELECT subtotal, cgst_total, sgst_total, total FROM invoices WHERE id = $1', [draft.body.id]
  );
  const { rows: lines } = await query(
    'SELECT line_total, cgst_amount, sgst_amount FROM invoice_line_items WHERE invoice_id = $1', [draft.body.id]
  );

  for (const value of [rows[0].subtotal, rows[0].cgst_total, rows[0].sgst_total, rows[0].total,
                        lines[0].line_total, lines[0].cgst_amount, lines[0].sgst_amount]) {
    const decimals = (String(value).split('.')[1] || '').length;
    assert.ok(decimals <= 2, `${value} has ${decimals} decimal places, expected at most 2`);
  }

  // 1.005 × 3 = 3.015 → 3.02 (half-up line total).
  assert.equal(Number(lines[0].line_total), 3.02);
  // 7.5% split into 3.75% CGST + 3.75% SGST: 3.02 * 0.0375 = 0.11325 -> 0.11.
  assert.equal(Number(lines[0].cgst_amount), 0.11);
  assert.equal(Number(lines[0].sgst_amount), 0.11);
});

test('the subtotal equals the sum of the line totals shown', async () => {
  // Three lines that each round up: a raw sum would round down to 0.99 while
  // each printed line says 0.34. The invoice has to add up to itself.
  const cheap = await createItem(company.id, { name: 'Fraction', sku: 'FR-1', quantity: 100, unit_price: 0.335 });
  const draft = await createDraft({
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
    customer_id: customer.id,
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
    line_items: [{ item_id: item.id, quantity: 1, unit_price: 10 }],
  });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /No such item/i);
});

test('an invoice needs a company, a customer and at least one line', async () => {
  const noCompany = await a.post('/api/invoices', {
    customer_name: 'X',
    line_items: [{ item_id: item.id, quantity: 1, unit_price: 1 }],
  });
  assert.equal(noCompany.status, 400);

  const noCustomer = await createDraft({ customer_id: null, customer_name: '' });
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
    customer_id: customer.id,
    customer_name: 'Riya Sharma (edited)',
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
    customer_name: 'Nope',
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
  const named = await createCustomer(company.id, { name: 'Priya Patel', gstin: null, state_code: '27' });
  const res = await createDraft({ customer_id: named.id, customer_name: undefined });

  assert.equal(res.status, 201);
  assert.equal(res.body.customer_id, named.id);
  assert.equal(res.body.customer_name, 'Priya Patel');
});

test('a customer_name override wins over the saved customer name', async () => {
  const named = await createCustomer(company.id, { name: 'Priya Patel', state_code: '27' });
  const res = await createDraft({ customer_id: named.id, customer_name: 'Attn: Accounts' });

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
  const res = await createDraft();

  assert.equal(res.status, 201);
  assert.equal(res.body.supplier_gstin, '27ABCDE1234F1Z5');
  assert.equal(res.body.supplier_name, 'TechCorp Supplies Pvt Ltd');
  assert.equal(res.body.supplier_state_code, '27');
  assert.equal(res.body.supplier_scheme, 'regular');
});

test('the supplier snapshot is frozen even if the company changes afterwards', async () => {
  const draft = await createDraft();

  await a.put(`/api/companies/${company.id}`, {
    name: 'TechCorp Supplies', legal_name: 'New Legal Name', state_code: '07',
  });

  const detail = await a.get(`/api/invoices/${draft.body.id}`);
  assert.equal(detail.body.supplier_name, 'TechCorp Supplies Pvt Ltd', 'snapshot must not follow later edits');
  assert.equal(detail.body.supplier_state_code, '27');
});

test('an unregistered company charges no tax even if its items carry a GST rate', async () => {
  const unregistered = await createCompany('Local Traders');
  const ratedItem = await createItem(unregistered.id, { quantity: 5, unit_price: 20, gst_rate: 18 });

  // No customer_id needed: an unregistered company never reaches the
  // place-of-supply requirement, since it never charges tax in the first place.
  const res = await a.post('/api/invoices', {
    company_id: unregistered.id,
    customer_name: 'Riya Sharma',
    line_items: [{ item_id: ratedItem.id, quantity: 1, unit_price: 20 }],
  });

  assert.equal(res.status, 201);
  assert.equal(Number(res.body.cgst_total), 0);
  assert.equal(Number(res.body.sgst_total), 0);
  assert.equal(Number(res.body.igst_total), 0);
  assert.equal(Number(res.body.total), 20);
});

test('a composition-scheme company charges no tax even if its items carry a GST rate', async () => {
  const composition = await createCompany('Composition Traders', {
    gstin: '07FGHIJ5678K1Z2', scheme: 'composition', state_code: '07',
  });
  const compositionCustomer = await createCustomer(composition.id, { name: 'Buyer', state_code: '07' });
  const ratedItem = await createItem(composition.id, { quantity: 5, unit_price: 20, gst_rate: 18 });

  const res = await a.post('/api/invoices', {
    company_id: composition.id,
    customer_id: compositionCustomer.id,
    line_items: [{ item_id: ratedItem.id, quantity: 1, unit_price: 20 }],
  });

  assert.equal(res.status, 201);
  assert.equal(Number(res.body.cgst_total), 0);
  assert.equal(Number(res.body.sgst_total), 0);
  assert.equal(Number(res.body.igst_total), 0);
  assert.equal(res.body.total, 20);
});

test('a registered, regular-scheme company cannot bill a manual-entry customer', async () => {
  // Place of supply is the customer's state, so a name with no saved record
  // behind it can't be taxed correctly — the company must bill a saved
  // customer instead.
  const res = await a.post('/api/invoices', {
    company_id: company.id,
    customer_name: 'Whoever Shows Up',
    line_items: [{ item_id: item.id, quantity: 1, unit_price: 59.99 }],
  });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /state/i);
});

test('a saved customer with no state on file is also refused for a tax-charging company', async () => {
  const noState = await createCustomer(company.id, { name: 'No State Co' });   // state_code null by default
  const res = await createDraft({ customer_id: noState.id, customer_name: undefined });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /state/i);
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

/* ── Phase 4a: per-company sequential numbering ──────────────────────────── */

test('a draft carries a placeholder number until it is finalized', async () => {
  const draft = await createDraft();
  assert.match(draft.body.invoice_no, /^INV-/, 'a draft keeps the old random-placeholder shape');

  const res = await a.post(`/api/invoices/${draft.body.id}/finalize`);
  assert.match(res.body.invoice.invoice_no, /^INV\/\d{2}-\d{2}\/\d{5}$/, 'finalize assigns the real series number');
  assert.notEqual(res.body.invoice.invoice_no, draft.body.invoice_no, 'the placeholder must be replaced, not kept');
});

test('finalized invoice numbers are sequential per company', async () => {
  const first  = await createDraft({ line_items: [{ item_id: item.id, quantity: 1, unit_price: 59.99 }] });
  const second = await createDraft({ line_items: [{ item_id: item.id, quantity: 1, unit_price: 59.99 }] });

  const firstFinal  = await a.post(`/api/invoices/${first.body.id}/finalize`);
  const secondFinal = await a.post(`/api/invoices/${second.body.id}/finalize`);

  assert.match(firstFinal.body.invoice.invoice_no, /\/00001$/);
  assert.match(secondFinal.body.invoice.invoice_no, /\/00002$/);
});

test('two companies finalizing interleaved get independent series', async () => {
  const other = await createCompany('Global Electronics');
  const otherItem = await createItem(other.id, { quantity: 10, unit_price: 5 });

  const mine  = await createDraft();
  const theirs = await a.post('/api/invoices', {
    company_id: other.id, customer_name: 'Someone Else',
    line_items: [{ item_id: otherItem.id, quantity: 1, unit_price: 5 }],
  });

  const mineFinal   = await a.post(`/api/invoices/${mine.body.id}/finalize`);
  const theirsFinal = await a.post(`/api/invoices/${theirs.body.id}/finalize`);

  // Both start their own series at 00001, independently of each other and of
  // creation order.
  assert.match(mineFinal.body.invoice.invoice_no, /\/00001$/);
  assert.match(theirsFinal.body.invoice.invoice_no, /\/00001$/);
});

test('a burst of concurrent finalizes for one company never collides', async () => {
  const drafts = await Promise.all(
    Array.from({ length: 10 }, () => createDraft({ line_items: [{ item_id: item.id, quantity: 1, unit_price: 59.99 }] }))
  );

  const finals = await Promise.all(drafts.map(d => a.post(`/api/invoices/${d.body.id}/finalize`)));
  assert.ok(finals.every(r => r.status === 200), 'every finalize should succeed');

  const numbers = new Set(finals.map(r => r.body.invoice.invoice_no));
  assert.equal(numbers.size, finals.length, 'sequential numbers collided under concurrency');
});

test('reversing and re-finalizing does not happen — a reversed invoice keeps its number', async () => {
  const draft = await createDraft();
  const finalized = await a.post(`/api/invoices/${draft.body.id}/finalize`);
  const invoiceNo = finalized.body.invoice.invoice_no;

  const reversed = await a.post(`/api/invoices/${draft.body.id}/reverse`);
  assert.equal(reversed.body.invoice.invoice_no, invoiceNo, 'reversal must not renumber the document');

  const again = await a.post(`/api/invoices/${draft.body.id}/finalize`);
  assert.equal(again.status, 409, 'a reversed invoice cannot be finalized again');
});
