const test = require('node:test');
const assert = require('node:assert/strict');

const { setupDatabase, resetData, teardownDatabase, query } = require('./helpers/db');
const { startServer, stopServer, agent } = require('./helpers/client');
const { createUser, createSubAdmin, createCompany, createItem, stockOf, PASSWORD } = require('./helpers/fixtures');

let a;

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
});

/** Enable the invoicing feature for a company directly, bypassing the admin-toggle API. */
async function enableInvoicing(companyId) {
  await query(
    `INSERT INTO company_features (company_id, feature_key) VALUES ($1, 'invoicing')
     ON CONFLICT DO NOTHING`,
    [companyId]
  );
}

/** A GST-registered company on the regular scheme, ready to charge tax. */
async function registeredCompany(overrides = {}) {
  return createCompany('Taxable Co', {
    gstin: '27ABCDE1234F1Z5', legal_name: 'Taxable Co Pvt Ltd',
    state_code: '27', scheme: 'regular', ...overrides,
  });
}

function draftPayload(companyId, item, overrides = {}) {
  return {
    company_id: companyId,
    customer_name: 'Riya Sharma',
    customer_address: '2 Market Road, Mumbai',
    customer_state_code: '27',
    line_items: [{ item_id: item.id, quantity: 2, unit_price: 100 }],
    ...overrides,
  };
}

/* ── Feature gating ────────────────────────────────────────────────────── */

test('creating an invoice is refused when invoicing is not enabled for the company', async () => {
  const company = await registeredCompany();
  const item = await createItem(company.id, { gst_rate: 18, hsn_sac_code: '8471', uqc: 'NOS' });

  const res = await a.post('/api/invoices', draftPayload(company.id, item));
  assert.equal(res.status, 403);
});

/* ── Draft creation and tax computation ───────────────────────────────── */

test('a draft is created with a placeholder number and preview totals', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { gst_rate: 18, hsn_sac_code: '8471', uqc: 'NOS', unit_price: 100 });

  const res = await a.post('/api/invoices', draftPayload(company.id, item));
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'draft');
  assert.match(res.body.invoice_no, /^INV-\d{8}-\d{4}$/);
  assert.equal(Number(res.body.subtotal), 200);
});

test('an intra-state sale (same state as supplier) splits tax into CGST+SGST', async () => {
  const company = await registeredCompany({ state_code: '27' });
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { gst_rate: 18, unit_price: 100 });

  const res = await a.post('/api/invoices', draftPayload(company.id, item, { customer_state_code: '27' }));
  assert.equal(res.status, 201);
  assert.equal(Number(res.body.cgst_total), 18); // 200 * 9%
  assert.equal(Number(res.body.sgst_total), 18); // 200 * 9%
  assert.equal(Number(res.body.igst_total), 0);
});

test('an inter-state sale charges IGST only', async () => {
  const company = await registeredCompany({ state_code: '27' });
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { gst_rate: 18, unit_price: 100 });

  const res = await a.post('/api/invoices', draftPayload(company.id, item, { customer_state_code: '07' }));
  assert.equal(res.status, 201);
  assert.equal(Number(res.body.cgst_total), 0);
  assert.equal(Number(res.body.sgst_total), 0);
  assert.equal(Number(res.body.igst_total), 36); // 200 * 18%
});

test('an unregistered company charges no tax even when its items carry a GST rate', async () => {
  const company = await createCompany('No GSTIN Co'); // no gstin, no scheme override -> not chargeable
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { gst_rate: 18, unit_price: 100 });

  const res = await a.post('/api/invoices', draftPayload(company.id, item, { customer_state_code: null }));
  assert.equal(res.status, 201);
  assert.equal(Number(res.body.cgst_total), 0);
  assert.equal(Number(res.body.igst_total), 0);
  assert.equal(Number(res.body.total), 200);
});

test('a composition-scheme company charges no tax either', async () => {
  const company = await registeredCompany({ scheme: 'composition' });
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { gst_rate: 18, unit_price: 100 });

  const res = await a.post('/api/invoices', draftPayload(company.id, item, { customer_state_code: null }));
  assert.equal(res.status, 201);
  assert.equal(Number(res.body.total), 200);
});

test('a taxable company requires the customer state to compute tax', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { gst_rate: 18 });

  const res = await a.post('/api/invoices', draftPayload(company.id, item, { customer_state_code: null }));
  assert.equal(res.status, 400);
});

test('an item from another company cannot be billed', async () => {
  const company = await registeredCompany();
  const other = await createCompany('Other Co');
  await enableInvoicing(company.id);
  const foreignItem = await createItem(other.id, { gst_rate: 18 });

  const res = await a.post('/api/invoices', draftPayload(company.id, foreignItem));
  assert.equal(res.status, 404);
});

/* ── Finalize / stock ledger ──────────────────────────────────────────── */

test('finalizing allocates a real sequential number and deducts stock through the ledger', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { quantity: 10, gst_rate: 18, unit_price: 100 });

  const draft = await a.post('/api/invoices', draftPayload(company.id, item, { line_items: [{ item_id: item.id, quantity: 3, unit_price: 100 }] }));
  const finalized = await a.post(`/api/invoices/${draft.body.id}/finalize`);

  assert.equal(finalized.status, 200);
  assert.equal(finalized.body.status, 'finalized');
  assert.match(finalized.body.invoice_no, /^INV\/\d{2}-\d{2}\/\d{5}$/);
  assert.equal(await stockOf(item.id), 7);

  const { rows: movements } = await query(
    'SELECT reason, quantity_delta FROM stock_movements WHERE item_id = $1', [item.id]
  );
  assert.equal(movements.length, 1);
  assert.equal(movements[0].reason, 'invoice_finalize');
  assert.equal(Number(movements[0].quantity_delta), -3);
});

test('two lines billing the same item both apply, netted into one stock update', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { quantity: 20, unit_price: 10 });

  const draft = await a.post('/api/invoices', draftPayload(company.id, item, {
    line_items: [
      { item_id: item.id, quantity: 3, unit_price: 10 },
      { item_id: item.id, quantity: 5, unit_price: 10 },
    ],
  }));
  assert.equal(draft.status, 201);

  const finalized = await a.post(`/api/invoices/${draft.body.id}/finalize`);
  assert.equal(finalized.status, 200);
  // Both lines' quantities must be deducted (3 + 5 = 8), not just one of them
  // — a naive multi-row UPDATE keyed by item id would silently apply only
  // the last matching line.
  assert.equal(await stockOf(item.id), 12);

  const { rows: movements } = await query(
    'SELECT quantity_delta FROM stock_movements WHERE item_id = $1 AND reason = $2 ORDER BY id',
    [item.id, 'invoice_finalize']
  );
  // One ledger row per line — audit granularity is unchanged even though the
  // item-quantity update itself was netted into a single statement.
  assert.equal(movements.length, 2);
  assert.deepEqual(movements.map(m => Number(m.quantity_delta)).sort((a, b) => a - b), [-5, -3]);
});

test('invoice numbers are sequential per company', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { quantity: 100 });

  const d1 = await a.post('/api/invoices', draftPayload(company.id, item, { line_items: [{ item_id: item.id, quantity: 1, unit_price: 10 }] }));
  const f1 = await a.post(`/api/invoices/${d1.body.id}/finalize`);
  const d2 = await a.post('/api/invoices', draftPayload(company.id, item, { line_items: [{ item_id: item.id, quantity: 1, unit_price: 10 }] }));
  const f2 = await a.post(`/api/invoices/${d2.body.id}/finalize`);

  assert.match(f1.body.invoice_no, /\/00001$/);
  assert.match(f2.body.invoice_no, /\/00002$/);
});

test('finalizing beyond available stock is refused and nothing is deducted', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { quantity: 2 });

  const draft = await a.post('/api/invoices', draftPayload(company.id, item, { line_items: [{ item_id: item.id, quantity: 5, unit_price: 10 }] }));
  const res = await a.post(`/api/invoices/${draft.body.id}/finalize`);

  assert.equal(res.status, 409);
  assert.equal(await stockOf(item.id), 2);
  const { rows } = await query('SELECT status FROM invoices WHERE id = $1', [draft.body.id]);
  assert.equal(rows[0].status, 'draft');
});

test('finalizing twice is refused', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { quantity: 10 });

  const draft = await a.post('/api/invoices', draftPayload(company.id, item, { line_items: [{ item_id: item.id, quantity: 1, unit_price: 10 }] }));
  await a.post(`/api/invoices/${draft.body.id}/finalize`);
  const again = await a.post(`/api/invoices/${draft.body.id}/finalize`);

  assert.equal(again.status, 409);
});

/* ── Reverse ──────────────────────────────────────────────────────────── */

test('reversing a finalized invoice restores stock through the ledger', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { quantity: 10 });

  const draft = await a.post('/api/invoices', draftPayload(company.id, item, { line_items: [{ item_id: item.id, quantity: 4, unit_price: 10 }] }));
  await a.post(`/api/invoices/${draft.body.id}/finalize`);
  assert.equal(await stockOf(item.id), 6);

  const res = await a.post(`/api/invoices/${draft.body.id}/reverse`);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'reversed');
  assert.equal(await stockOf(item.id), 10);

  const { rows: movements } = await query(
    `SELECT reason FROM stock_movements WHERE item_id = $1 ORDER BY id DESC LIMIT 1`, [item.id]
  );
  assert.equal(movements[0].reason, 'invoice_reversal');
});

test('a draft cannot be reversed', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { quantity: 10 });

  const draft = await a.post('/api/invoices', draftPayload(company.id, item, { line_items: [{ item_id: item.id, quantity: 1, unit_price: 10 }] }));
  const res = await a.post(`/api/invoices/${draft.body.id}/reverse`);
  assert.equal(res.status, 409);
});

test('an invoice cannot be reversed twice', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { quantity: 10 });

  const draft = await a.post('/api/invoices', draftPayload(company.id, item, { line_items: [{ item_id: item.id, quantity: 1, unit_price: 10 }] }));
  await a.post(`/api/invoices/${draft.body.id}/finalize`);
  await a.post(`/api/invoices/${draft.body.id}/reverse`);
  const again = await a.post(`/api/invoices/${draft.body.id}/reverse`);
  assert.equal(again.status, 409);
});

/* ── Draft-only edit/delete ───────────────────────────────────────────── */

test('a finalized invoice can be neither edited nor deleted', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { quantity: 10 });

  const draft = await a.post('/api/invoices', draftPayload(company.id, item, { line_items: [{ item_id: item.id, quantity: 1, unit_price: 10 }] }));
  await a.post(`/api/invoices/${draft.body.id}/finalize`);

  const edit = await a.put(`/api/invoices/${draft.body.id}`, draftPayload(company.id, item));
  assert.equal(edit.status, 409);

  const del = await a.del(`/api/invoices/${draft.body.id}`);
  assert.equal(del.status, 409);
});

test('a draft can be edited, and its totals recomputed', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { quantity: 10, gst_rate: 18, unit_price: 100 });

  const draft = await a.post('/api/invoices', draftPayload(company.id, item, { line_items: [{ item_id: item.id, quantity: 1, unit_price: 100 }] }));
  const edited = await a.put(`/api/invoices/${draft.body.id}`, draftPayload(company.id, item, {
    line_items: [{ item_id: item.id, quantity: 3, unit_price: 100 }],
  }));

  assert.equal(edited.status, 200);
  assert.equal(Number(edited.body.subtotal), 300);
});

test('a draft can be deleted, taking its line items with it', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { quantity: 10 });

  const draft = await a.post('/api/invoices', draftPayload(company.id, item, { line_items: [{ item_id: item.id, quantity: 1, unit_price: 10 }] }));
  const res = await a.del(`/api/invoices/${draft.body.id}`);
  assert.equal(res.status, 200);

  const { rows } = await query('SELECT 1 FROM invoice_line_items WHERE invoice_id = $1', [draft.body.id]);
  assert.equal(rows.length, 0);
});

/* ── RBAC ─────────────────────────────────────────────────────────────── */

test('a sub-admin without access to the company gets 404, not 403', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { quantity: 10 });
  await createSubAdmin('sub_ops', []); // no companies assigned
  const subAgent = agent();
  await subAgent.login('sub_ops', PASSWORD);

  const res = await subAgent.post('/api/invoices', draftPayload(company.id, item));
  assert.equal(res.status, 404);
});

test('a sub-admin with company access but no invoicing feature gets 403', async () => {
  const company = await registeredCompany(); // invoicing NOT enabled
  const item = await createItem(company.id, { quantity: 10 });
  await createSubAdmin('sub_ops', [company.id]);
  const subAgent = agent();
  await subAgent.login('sub_ops', PASSWORD);

  const res = await subAgent.post('/api/invoices', draftPayload(company.id, item));
  assert.equal(res.status, 403);
});

test('a sub-admin with access and the feature enabled can manage invoices', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { quantity: 10 });
  await createSubAdmin('sub_ops', [company.id]);
  const subAgent = agent();
  await subAgent.login('sub_ops', PASSWORD);

  const res = await subAgent.post('/api/invoices', draftPayload(company.id, item));
  assert.equal(res.status, 201);
  assert.equal((await subAgent.post(`/api/invoices/${res.body.id}/finalize`)).status, 200);
});

/* ── PDF ──────────────────────────────────────────────────────────────── */

test('the PDF endpoint returns a PDF document', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { quantity: 10, gst_rate: 18, hsn_sac_code: '8471', uqc: 'NOS' });

  const draft = await a.post('/api/invoices', draftPayload(company.id, item, { reverse_charge: true }));
  await a.post(`/api/invoices/${draft.body.id}/finalize`);

  const res = await a.get(`/api/invoices/${draft.body.id}/pdf`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/pdf/);
});

/* ── Summary / listing ────────────────────────────────────────────────── */

test('the summary endpoint reports finalized revenue and draft count separately', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { quantity: 100, unit_price: 50 });

  const finalizedOne = await a.post('/api/invoices', draftPayload(company.id, item, { line_items: [{ item_id: item.id, quantity: 2, unit_price: 50 }] }));
  await a.post(`/api/invoices/${finalizedOne.body.id}/finalize`);
  await a.post('/api/invoices', draftPayload(company.id, item, { line_items: [{ item_id: item.id, quantity: 1, unit_price: 50 }] })); // stays a draft

  const res = await a.get(`/api/invoices/company/${company.id}/summary`);
  assert.equal(res.status, 200);
  assert.equal(res.body.total_invoices, 2);
  assert.equal(res.body.draft_count, 1);
  assert.equal(Number(res.body.finalized_revenue), 100);
});

/* ── idempotent draft creation ────────────────────────────────────────────── */

test('two draft creations with the same Idempotency-Key return the same invoice, not two', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { gst_rate: 18, unit_price: 100 });

  const key = 'retry-key-abc123';
  const first  = await a.post('/api/invoices', draftPayload(company.id, item), { 'Idempotency-Key': key });
  const second = await a.post('/api/invoices', draftPayload(company.id, item), { 'Idempotency-Key': key });

  assert.equal(first.status, 201);
  assert.equal(second.status, 200, 'a replayed request is not a new creation');
  assert.equal(second.body.id, first.body.id, 'the exact same draft is returned, not a duplicate');

  const { rows } = await query('SELECT COUNT(*)::int AS n FROM invoices WHERE company_id = $1', [company.id]);
  assert.equal(rows[0].n, 1, 'only one invoice row actually exists');
});

test('the same Idempotency-Key on a different company is not treated as a collision', async () => {
  const companyA = await createCompany('Company A', {
    gstin: '27ABCDE1234F1Z5', legal_name: 'Company A Pvt Ltd', state_code: '27', scheme: 'regular',
  });
  const companyB = await createCompany('Company B', {
    gstin: '07ABCDE1234F1Z5', legal_name: 'Company B Pvt Ltd', state_code: '07', scheme: 'regular',
  });
  await enableInvoicing(companyA.id);
  await enableInvoicing(companyB.id);
  const itemA = await createItem(companyA.id, { gst_rate: 18, unit_price: 100 });
  const itemB = await createItem(companyB.id, { gst_rate: 18, unit_price: 100 });

  const key = 'shared-key';
  const resA = await a.post('/api/invoices', draftPayload(companyA.id, itemA), { 'Idempotency-Key': key });
  const resB = await a.post('/api/invoices', draftPayload(companyB.id, itemB), { 'Idempotency-Key': key });

  assert.equal(resA.status, 201);
  assert.equal(resB.status, 201, 'same key, different company — a genuinely new draft, not a replay');
  assert.notEqual(resA.body.id, resB.body.id);
});

test('omitting Idempotency-Key behaves exactly as before — every call creates a new draft', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { gst_rate: 18, unit_price: 100 });

  const first  = await a.post('/api/invoices', draftPayload(company.id, item));
  const second = await a.post('/api/invoices', draftPayload(company.id, item));

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(first.body.id, second.body.id);
});

/* ── keyset pagination on GET /company/:companyId ────────────────────────── */

test('the invoice list needs no cursor for the first page and reports nextCursor when there is more', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { quantity: 100 });

  for (let i = 0; i < 3; i++) {
    await a.post('/api/invoices', draftPayload(company.id, item, { line_items: [{ item_id: item.id, quantity: 1, unit_price: 10 }] }));
  }

  const res = await a.get(`/api/invoices/company/${company.id}?limit=2`);
  assert.equal(res.status, 200);
  assert.equal(res.body.invoices.length, 2);
  assert.equal(res.body.total, 3);
  assert.ok(res.body.nextCursor);

  const secondPage = await a.get(`/api/invoices/company/${company.id}?limit=2&cursor=${encodeURIComponent(res.body.nextCursor)}`);
  assert.equal(secondPage.body.invoices.length, 1);
  assert.equal(secondPage.body.nextCursor, null);

  // No invoice id appears on both pages.
  const idsA = res.body.invoices.map(i => i.id);
  const idsB = secondPage.body.invoices.map(i => i.id);
  assert.equal(idsA.filter(id => idsB.includes(id)).length, 0);
});

test('omitting cursor on a repeat call still returns the first page — existing frontend usage is unaffected', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { quantity: 100 });
  await a.post('/api/invoices', draftPayload(company.id, item, { line_items: [{ item_id: item.id, quantity: 1, unit_price: 10 }] }));

  const first  = await a.get(`/api/invoices/company/${company.id}`);
  const second = await a.get(`/api/invoices/company/${company.id}`);
  assert.deepEqual(first.body.invoices.map(i => i.id), second.body.invoices.map(i => i.id));
});

test('a malformed invoice-list cursor is a 400', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  // Valid base64url, but not JSON once decoded — exercises the JSON.parse
  // failure path deterministically, without depending on URL-encoding of
  // characters outside the base64url alphabet.
  const res = await a.get(`/api/invoices/company/${company.id}?cursor=aGVsbG8`);
  assert.equal(res.status, 400);
});

/* ── requireFeature caching ───────────────────────────────────────────── */

test('disabling invoicing takes effect immediately, not after a cache TTL', async () => {
  const company = await registeredCompany();
  await enableInvoicing(company.id);
  const item = await createItem(company.id, { quantity: 10 });

  // Populate requireFeature's cache for this company.
  assert.equal((await a.get(`/api/invoices/company/${company.id}`)).status, 200);

  // Disable through the real API, which must evict that cache entry.
  const off = await a.del(`/api/features/company/${company.id}/invoicing`);
  assert.equal(off.status, 200);

  assert.equal((await a.get(`/api/invoices/company/${company.id}`)).status, 403);
  const denied = await a.post('/api/invoices', draftPayload(company.id, item));
  assert.equal(denied.status, 403);
});

test('re-enabling invoicing takes effect immediately after a prior denial was cached', async () => {
  const company = await registeredCompany();

  // Cache the "disabled" answer.
  assert.equal((await a.get(`/api/invoices/company/${company.id}`)).status, 403);

  // Enable through the real API — this must evict the cached denial.
  const on = await a.post(`/api/features/company/${company.id}/invoicing`);
  assert.equal(on.status, 201);

  assert.equal((await a.get(`/api/invoices/company/${company.id}`)).status, 200);
});
