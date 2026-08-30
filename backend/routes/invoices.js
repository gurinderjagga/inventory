const express = require('express');
const PDFDocument = require('pdfkit');
const { query, runTransaction } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { ValidationError, NotFoundError, ConflictError } = require('../lib/errors');
const v = require('../lib/validate');
const money = require('../lib/money');
const { formatAmount } = require('../lib/currency');
const { applyMovement } = require('../lib/stockLedger');
const gst = require('../lib/gst');

const router = express.Router();
router.use(authMiddleware);

/** A draft's placeholder number — replaced with a real one at finalize. */
function generateInvoiceNo() {
  const now = new Date();
  const datePart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const randPart = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `INV-${datePart}-${randPart}`;
}

/**
 * Allocate the next sequential number in a company's series, atomically.
 *
 * A single `INSERT ... ON CONFLICT DO UPDATE` rather than the more common
 * `SELECT ... FOR UPDATE` then `UPDATE` pair — Postgres serializes concurrent
 * upserts on the same conflict key via the same row-level locking a separate
 * SELECT FOR UPDATE would need, so this gets the same race-safety in one
 * statement instead of two.
 */
async function allocateInvoiceNumber(client, companyId, documentType = 'invoice') {
  const fy = gst.financialYear();
  const { rows } = await client.query(
    `INSERT INTO invoice_number_series (company_id, document_type, financial_year, next_number)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (company_id, document_type, financial_year)
     DO UPDATE SET next_number = invoice_number_series.next_number + 1
     RETURNING next_number`,
    [companyId, documentType, fy]
  );
  return gst.formatInvoiceNumber(documentType, fy, rows[0].next_number);
}

/**
 * Normalise and validate the line items of an incoming invoice.
 *
 * Shared by create and update so a draft cannot be edited into a state the
 * create path would have rejected. Every line is checked before the database
 * is touched, so a bad line is a 400 rather than a foreign-key failure.
 *
 * The company_id filter matters twice over: it stops one tenant billing
 * another tenant's stock, and it stops an invoice mixing items across
 * companies, which would make the stock deduction on finalize incoherent.
 */
async function normalizeLines(companyId, line_items) {
  if (!Array.isArray(line_items) || line_items.length === 0) {
    throw new ValidationError('At least one line item is required');
  }

  const lines = line_items.map((li, idx) => {
    const label = `Line ${idx + 1}`;
    const qty   = v.nonNegativeNumber(li.quantity, `${label} quantity`);
    if (qty <= 0) throw new ValidationError(`${label} quantity must be greater than 0`);
    return {
      itemId:    v.id(li.item_id, `${label} item_id`),
      quantity:  qty,
      unitPrice: v.nonNegativeNumber(li.unit_price, `${label} unit price`, { fallback: 0 }),
    };
  });

  // Use the stored name and GST rate so a client cannot mislabel a line or
  // manufacture its own tax rate — both come from the database, never the
  // request.
  const ids = [...new Set(lines.map(l => l.itemId))];
  const { rows: found } = await query(
    'SELECT id, name, gst_rate FROM items WHERE id = ANY($1::int[]) AND company_id = $2',
    [ids, companyId]
  );
  const byId  = new Map(found.map(r => [r.id, r]));
  const missing  = ids.filter(id => !byId.has(id));
  if (missing.length) {
    throw new ValidationError(
      `No such item${missing.length === 1 ? '' : 's'} for this company: ${missing.join(', ')}`
    );
  }

  return lines.map(l => ({
    ...l,
    itemName: byId.get(l.itemId).name,
    gstRate:  byId.get(l.itemId).gst_rate,
  }));
}

/**
 * Money and tax totals for a set of normalised lines.
 *
 * Every step goes through lib/money.js and lib/gst.js rather than JavaScript
 * arithmetic: the pre-Phase-4 version computed `quantity * unitPrice` on
 * doubles, so a three-line invoice could store a total a paisa away from the
 * sum of its own printed lines. The subtotal is the sum of the ROUNDED line
 * totals, deliberately — that is the figure each line shows, and an invoice
 * whose lines do not add up to its total is indefensible in front of an
 * auditor.
 *
 * Tax runs per line at that line's own item's GST rate (never a manual,
 * invoice-wide rate) only when `chargesTax` — a company with no GSTIN, or on
 * the composition scheme, never charges tax no matter what its items say.
 * `intraState` picks CGST+SGST vs IGST for every line alike, since place of
 * supply is a property of the invoice (the customer's state), not the item.
 */
function invoiceTotals(lines, { chargesTax, intraState }) {
  const lineTaxes = lines.map(l => {
    const lineTotal = money.lineTotal(l.quantity, l.unitPrice);
    return chargesTax
      ? gst.computeLineTax(lineTotal, l.gstRate, intraState)
      : { cgst: '0.00', sgst: '0.00', igst: '0.00' };
  });

  const subtotal   = money.sum(lines.map(l => money.lineTotal(l.quantity, l.unitPrice)));
  const cgstTotal  = money.sum(lineTaxes.map(t => t.cgst));
  const sgstTotal  = money.sum(lineTaxes.map(t => t.sgst));
  const igstTotal  = money.sum(lineTaxes.map(t => t.igst));
  const preRound   = money.sum([subtotal, cgstTotal, sgstTotal, igstTotal]);

  // Round-to-the-nearest-rupee is a GST invoicing convention that exists
  // *because* there is tax to round around — an untaxed invoice (no GSTIN,
  // composition scheme, or every line nil-rated) stays exact to the paisa
  // like every other total in this app, rather than rounding for its own sake.
  const hasTax = !money.dec(cgstTotal).plus(sgstTotal).plus(igstTotal).isZero();
  const { total, roundOff } = hasTax
    ? gst.roundToRupee(preRound)
    : { total: preRound, roundOff: '0.00' };

  return { subtotal, cgstTotal, sgstTotal, igstTotal, roundOff, total, lineTaxes };
}

/**
 * A draft is the only editable/deletable state — both `finalized` and
 * `reversed` are terminal, for the same reason: each is part of the
 * financial/inventory record once it happens, not a thing to quietly rewrite.
 */
function assertIsDraft(status, action) {
  if (status === 'draft') return;
  const already = status === 'finalized' ? 'finalized' : 'reversed';
  throw new ConflictError(`This invoice has been ${already} and can no longer be ${action}.`);
}

/**
 * Write the line items of an invoice, replacing whatever is already there.
 * `lineTaxes` is `invoiceTotals`'s per-line CGST/SGST/IGST breakdown, in the
 * same order as `lines` — computed once and threaded through rather than
 * recomputed here, so the totals and the stored lines can never disagree.
 */
async function writeLines(client, invoiceId, lines, lineTaxes) {
  await client.query('DELETE FROM invoice_line_items WHERE invoice_id = $1', [invoiceId]);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const t = lineTaxes[i];
    await client.query(
      `INSERT INTO invoice_line_items
         (invoice_id, item_id, item_name, quantity, unit_price, line_total,
          gst_rate, cgst_amount, sgst_amount, igst_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        invoiceId, l.itemId, l.itemName,
        money.quantity(l.quantity), money.money(l.unitPrice),
        money.lineTotal(l.quantity, l.unitPrice),
        l.gstRate, t.cgst, t.sgst, t.igst,
      ]
    );
  }
}

// GET /api/invoices  — all invoices with company name
router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await query(`
    SELECT i.*, c.name AS company_name
    FROM invoices i
    JOIN companies c ON c.id = i.company_id
    ORDER BY i.created_at DESC
  `);
  res.json(rows);
}));

// GET /api/invoices/summary/stats  — dashboard summary (MUST be before /:id)
router.get('/summary/stats', asyncHandler(async (req, res) => {
  const { rows } = await query(`
    SELECT
      COUNT(*)                                                               AS total_invoices,
      COALESCE(SUM(CASE WHEN status = 'finalized' THEN total ELSE 0 END), 0) AS total_revenue,
      COUNT(*) FILTER (WHERE status = 'draft')                               AS draft_count
    FROM invoices
  `);
  const r = rows[0];
  res.json({
    totalInvoices: Number(r.total_invoices),
    totalRevenue:  Number(r.total_revenue),
    draftCount:    Number(r.draft_count),
  });
}));

// GET /api/invoices/:id  — invoice + line items
router.get('/:id', asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Invoice id');

  const { rows } = await query(`
    SELECT i.*, c.name AS company_name, c.email AS company_email,
           c.phone AS company_phone, c.address AS company_address
    FROM invoices i
    JOIN companies c ON c.id = i.company_id
    WHERE i.id = $1
  `, [id]);

  const invoice = rows[0];
  if (!invoice) throw new NotFoundError('Invoice not found');

  const lines = await query(
    'SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY id',
    [id]
  );
  invoice.line_items = lines.rows;

  res.json(invoice);
}));

const isBlank = (val) => val === undefined || val === null || val === '';

/**
 * Resolve the billed customer, scoped to the invoice's own company — the same
 * anti-cross-tenant guard normalizeLines() applies to items, so one company
 * cannot bill against another company's customer record.
 *
 * customer_id is the primary link; customer_name/customer_email are kept as a
 * manual override (or a fallback for a caller that hasn't migrated to picking
 * a saved customer yet) rather than removed outright.
 */
async function resolveCustomer(companyId, { customer_id, customer_name, customer_email }) {
  let name = v.optionalString(customer_name);
  let customerId = null;
  let stateCode  = null;

  if (!isBlank(customer_id)) {
    customerId = v.id(customer_id, 'customer_id');
    const { rows } = await query(
      'SELECT id, name, state_code FROM customers WHERE id = $1 AND company_id = $2',
      [customerId, companyId]
    );
    if (!rows[0]) throw new ValidationError('No such customer for this company');
    name = name || rows[0].name;
    stateCode = rows[0].state_code;
  }

  if (!name) throw new ValidationError('customer_name is required');
  return { customerId, name, email: v.optionalString(customer_email), stateCode };
}

/**
 * Freeze the supplier's own GST identity onto the invoice at issue — a company
 * that later registers, or moves state or scheme, must not retroactively
 * change a document already sent.
 */
function snapshotSupplier(company) {
  return {
    gstin:     company.gstin || null,
    name:      company.legal_name || company.name,
    address:   company.address || null,
    stateCode: company.state_code || null,
    scheme:    company.scheme,
  };
}

/**
 * Decide whether this invoice charges GST at all, and if so, on which side of
 * the state line the customer sits.
 *
 * Only a company with a GSTIN on the `regular` scheme ever charges tax
 * (Section 122 makes charging it without registration an offence, and a
 * composition dealer is barred from charging it at all) — regardless of what
 * rate any item carries. Place of supply is the customer's state, which is
 * why a tax-charging company can only bill a saved customer that has one.
 */
function taxContext(company, customer) {
  const registered = !!company.gstin && company.scheme === 'regular';
  if (!registered) return { chargesTax: false, intraState: null };
  if (!customer.stateCode) {
    throw new ValidationError(
      'A customer with a state on file is required to bill a GST-registered company — ' +
      'pick a saved customer rather than typing a name.'
    );
  }
  return { chargesTax: true, intraState: customer.stateCode === company.state_code };
}

// POST /api/invoices  — create draft invoice (atomic via transaction)
router.post('/', asyncHandler(async (req, res) => {
  const { company_id, notes, line_items } = req.body;

  const companyId = v.id(company_id, 'company_id');

  const { rows: company } = await query('SELECT * FROM companies WHERE id = $1', [companyId]);
  if (!company[0]) throw new NotFoundError('Company not found');

  const customer = await resolveCustomer(companyId, req.body);
  const supplier = snapshotSupplier(company[0]);
  const tax      = taxContext(company[0], customer);
  const lines    = await normalizeLines(companyId, line_items);
  const { subtotal, cgstTotal, sgstTotal, igstTotal, roundOff, total, lineTaxes } =
    invoiceTotals(lines, tax);

  const invoice = await runTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO invoices
         (invoice_no, company_id, customer_id, customer_name, customer_email, notes,
          subtotal, cgst_total, sgst_total, igst_total, round_off, total, status,
          supplier_gstin, supplier_name, supplier_address, supplier_state_code, supplier_scheme,
          place_of_supply_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'draft', $13, $14, $15, $16, $17, $18)
       RETURNING *`,
      [
        generateInvoiceNo(), companyId, customer.customerId, customer.name,
        customer.email, v.optionalString(notes),
        subtotal, cgstTotal, sgstTotal, igstTotal, roundOff, total,
        supplier.gstin, supplier.name, supplier.address, supplier.stateCode, supplier.scheme,
        customer.stateCode,
      ]
    );
    const created = rows[0];
    await writeLines(client, created.id, lines, lineTaxes);
    return created;
  });

  res.status(201).json(invoice);
}));

// PUT /api/invoices/:id  — edit a draft (finalized invoices are immutable)
//
// Without this a draft that fails to finalize — almost always because stock
// moved underneath it — was a dead end: the only way out was deleting it and
// retyping every line. The company is deliberately not editable; changing it
// would orphan every line item against another tenant's stock.
router.put('/:id', asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Invoice id');
  const { notes, line_items } = req.body;

  const { rows: existing } = await query(
    'SELECT id, company_id, status FROM invoices WHERE id = $1',
    [id]
  );
  const current = existing[0];
  if (!current) throw new NotFoundError('Invoice not found');
  assertIsDraft(current.status, 'edited');

  // The company itself is immutable on edit, but tax is re-derived from
  // scratch here too: the customer or line items can change on a draft, and
  // both feed the tax engine.
  const { rows: company } = await query('SELECT * FROM companies WHERE id = $1', [current.company_id]);
  const customer = await resolveCustomer(current.company_id, req.body);
  const tax      = taxContext(company[0], customer);
  const lines    = await normalizeLines(current.company_id, line_items);
  const { subtotal, cgstTotal, sgstTotal, igstTotal, roundOff, total, lineTaxes } =
    invoiceTotals(lines, tax);

  const invoice = await runTransaction(async (client) => {
    // Re-check the status under a row lock: a concurrent finalize must not be
    // overwritten by an edit that started while the invoice was still a draft.
    const { rows: locked } = await client.query(
      'SELECT status FROM invoices WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!locked[0]) throw new NotFoundError('Invoice not found');
    assertIsDraft(locked[0].status, 'edited');

    const { rows } = await client.query(
      `UPDATE invoices
       SET customer_id = $1, customer_name = $2, customer_email = $3, notes = $4,
           subtotal = $5, cgst_total = $6, sgst_total = $7, igst_total = $8,
           round_off = $9, total = $10, place_of_supply_state = $11, updated_at = now()
       WHERE id = $12
       RETURNING *`,
      [
        customer.customerId, customer.name, customer.email, v.optionalString(notes),
        subtotal, cgstTotal, sgstTotal, igstTotal, roundOff, total, customer.stateCode, id,
      ]
    );
    await writeLines(client, id, lines, lineTaxes);
    return rows[0];
  });

  res.json(invoice);
}));

// POST /api/invoices/:id/finalize  — atomic stock deduction
router.post('/:id/finalize', asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Invoice id');

  // Any error thrown inside runTransaction rolls the whole thing back, so a
  // partial stock deduction is not possible. Typed errors become 4xx; anything
  // unexpected reaches the global handler as a 500.
  const updated = await runTransaction(async (client) => {
    // Re-read under a row lock so two concurrent finalize requests cannot both
    // pass the status check and deduct stock twice.
    const { rows: invRows } = await client.query(
      'SELECT * FROM invoices WHERE id = $1 FOR UPDATE',
      [id]
    );
    const invoice = invRows[0];
    if (!invoice) throw new NotFoundError('Invoice not found');
    if (invoice.status === 'finalized') {
      throw new ConflictError('This invoice has already been finalized');
    }
    // Reversed is terminal too — re-finalizing would deduct stock a second
    // time for a sale the ledger already says was undone.
    if (invoice.status === 'reversed') {
      throw new ConflictError('This invoice has been reversed and can no longer be finalized.');
    }

    const { rows: lineItems } = await client.query(
      'SELECT * FROM invoice_line_items WHERE invoice_id = $1',
      [id]
    );
    if (lineItems.length === 0) {
      throw new ValidationError('Invoice has no line items');
    }

    for (const line of lineItems) {
      // Ledgered, atomic deduction — throws ConflictError if stock is short.
      await applyMovement(client, {
        itemId: line.item_id, companyId: invoice.company_id,
        delta: -line.quantity, reason: 'invoice_finalize',
        invoiceId: id, userId: req.user.id,
      });
    }

    // The real invoice number is taken here, at issue — not at draft
    // creation, or every abandoned draft would burn a number out of the
    // series. Replaces the random placeholder generateInvoiceNo() stamped it
    // with.
    const invoiceNo = await allocateInvoiceNumber(client, invoice.company_id);

    const { rows } = await client.query(
      `UPDATE invoices SET status = 'finalized', invoice_no = $2 WHERE id = $1 RETURNING *`,
      [id, invoiceNo]
    );
    return rows[0];
  });

  res.json({ message: 'Invoice finalized and stock deducted successfully', invoice: updated });
}));

// POST /api/invoices/:id/reverse  — restore stock through the ledger
//
// The statutory document wrapping this (a credit note) is Phase 4's job; this
// is only the mechanism. A reversed invoice is exactly as immutable as a
// finalized one afterward — it is part of the record, not a draft again.
router.post('/:id/reverse', asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Invoice id');

  const updated = await runTransaction(async (client) => {
    const { rows: invRows } = await client.query(
      'SELECT * FROM invoices WHERE id = $1 FOR UPDATE',
      [id]
    );
    const invoice = invRows[0];
    if (!invoice) throw new NotFoundError('Invoice not found');
    if (invoice.status === 'draft') {
      throw new ConflictError('A draft has not deducted any stock, so there is nothing to reverse.');
    }
    if (invoice.status === 'reversed') {
      throw new ConflictError('This invoice has already been reversed');
    }

    const { rows: lineItems } = await client.query(
      'SELECT * FROM invoice_line_items WHERE invoice_id = $1',
      [id]
    );
    for (const line of lineItems) {
      await applyMovement(client, {
        itemId: line.item_id, companyId: invoice.company_id,
        delta: line.quantity, reason: 'invoice_reversal',
        invoiceId: id, userId: req.user.id,
      });
    }

    const { rows } = await client.query(
      `UPDATE invoices SET status = 'reversed' WHERE id = $1 RETURNING *`,
      [id]
    );
    return rows[0];
  });

  res.json({ message: 'Invoice reversed and stock restored', invoice: updated });
}));

// DELETE /api/invoices/:id  — only drafts can be deleted
router.delete('/:id', asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Invoice id');

  const { rows } = await query(
    'SELECT status FROM invoices WHERE id = $1',
    [id]
  );
  const invoice = rows[0];
  if (!invoice) throw new NotFoundError('Invoice not found');
  if (invoice.status !== 'draft') {
    throw new ConflictError(
      `${invoice.status === 'finalized' ? 'Finalized' : 'Reversed'} invoices cannot be deleted — ` +
      `they are part of your financial record.`
    );
  }
  await query('DELETE FROM invoices WHERE id = $1', [id]);
  res.json({ message: 'Invoice deleted' });
}));

// GET /api/invoices/:id/pdf  — stream PDF download
router.get('/:id/pdf', asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Invoice id');

  const { rows } = await query(`
    SELECT i.*, c.name AS company_name, c.email AS company_email,
           c.phone AS company_phone, c.address AS company_address
    FROM invoices i
    JOIN companies c ON c.id = i.company_id
    WHERE i.id = $1
  `, [id]);

  const invoice = rows[0];
  if (!invoice) throw new NotFoundError('Invoice not found');

  const { rows: lineItems } = await query(
    'SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY id',
    [id]
  );

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  // "attachment" so the browser saves the file, matching the UI's Download button.
  res.setHeader('Content-Disposition', `attachment; filename="${invoice.invoice_no}.pdf"`);
  doc.pipe(res);

  // ── Header ──────────────────────────────────────────────
  doc.fontSize(24).font('Helvetica-Bold').fillColor('#1e293b').text('INVOICE', 50, 50);
  doc.fontSize(10).font('Helvetica').fillColor('#64748b')
    .text(invoice.invoice_no, 50, 80)
    .text(`Date: ${new Date(invoice.created_at).toLocaleDateString()}`, 50, 95)
    .text(`Status: ${invoice.status.toUpperCase()}`, 50, 110);

  // Supplier name/address shown here is the frozen snapshot taken at issue,
  // not a live join — a company that re-registers or moves state afterward
  // must not retroactively change a document already sent. Falls back to the
  // live company row only for invoices created before this snapshot existed.
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e293b')
    .text(invoice.supplier_name || invoice.company_name, 300, 50, { align: 'right', width: 245 });
  doc.fontSize(9).font('Helvetica').fillColor('#64748b')
    .text(invoice.company_email || '', 300, 67, { align: 'right', width: 245 })
    .text(invoice.company_phone || '', 300, 80, { align: 'right', width: 245 })
    .text(invoice.supplier_address || invoice.company_address || '', 300, 93, { align: 'right', width: 245 });
  if (invoice.supplier_gstin) {
    doc.text(`GSTIN: ${invoice.supplier_gstin}`, 300, 106, { align: 'right', width: 245 });
  }

  // ── Bill To ─────────────────────────────────────────────
  doc.moveTo(50, 130).lineTo(545, 130).strokeColor('#e2e8f0').lineWidth(1).stroke();
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#64748b').text('BILL TO', 50, 145);
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e293b').text(invoice.customer_name, 50, 160);
  if (invoice.customer_email) {
    doc.fontSize(9).font('Helvetica').fillColor('#64748b').text(invoice.customer_email, 50, 176);
  }

  // ── Line Items Table ─────────────────────────────────────
  const tableTop = 220;
  const colX = [50, 290, 370, 460];
  const colW = [230, 70, 80, 80];
  const headers = ['Description', 'Qty', 'Unit Price', 'Total'];

  doc.rect(50, tableTop - 8, 495, 24).fill('#f8fafc');
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#475569');
  headers.forEach((h, i) => doc.text(h, colX[i], tableTop, { width: colW[i], align: i === 0 ? 'left' : 'right' }));

  let y = tableTop + 24;
  lineItems.forEach((item, idx) => {
    if (idx % 2 === 1) doc.rect(50, y - 4, 495, 20).fill('#f8fafc');
    doc.fontSize(9).font('Helvetica').fillColor('#1e293b')
      .text(item.item_name, colX[0], y, { width: colW[0] })
      .text(item.quantity.toString(), colX[1], y, { width: colW[1], align: 'right' })
      .text(formatAmount(item.unit_price), colX[2], y, { width: colW[2], align: 'right' })
      .text(formatAmount(item.line_total), colX[3], y, { width: colW[3], align: 'right' });
    y += 20;
  });

  // ── Totals ───────────────────────────────────────────────
  y += 10;
  doc.moveTo(350, y).lineTo(545, y).strokeColor('#e2e8f0').stroke();
  y += 10;

  doc.fontSize(9).fillColor('#64748b').font('Helvetica')
    .text('Subtotal:', 350, y, { width: 105, align: 'right' });
  doc.fillColor('#1e293b').text(formatAmount(invoice.subtotal), colX[3], y, { width: colW[3], align: 'right' });
  y += 16;

  // New-engine invoices carry their own CGST/SGST/IGST/round-off columns;
  // pre-Phase-4 invoices only ever had a flat tax_rate, which this falls back
  // to so they still render the tax they actually charged.
  const hasNewTax = invoice.cgst_total > 0 || invoice.sgst_total > 0 || invoice.igst_total > 0;
  if (hasNewTax) {
    const rows = [
      ['CGST:', invoice.cgst_total],
      ['SGST:', invoice.sgst_total],
      ['IGST:', invoice.igst_total],
    ].filter(([, amt]) => amt > 0);
    for (const [label, amt] of rows) {
      doc.fillColor('#64748b').text(label, 350, y, { width: 105, align: 'right' });
      doc.fillColor('#1e293b').text(formatAmount(amt), colX[3], y, { width: colW[3], align: 'right' });
      y += 16;
    }
    if (invoice.round_off != 0) {
      doc.fillColor('#64748b').text('Round Off:', 350, y, { width: 105, align: 'right' });
      doc.fillColor('#1e293b').text(formatAmount(invoice.round_off), colX[3], y, { width: colW[3], align: 'right' });
      y += 16;
    }
  } else if (invoice.tax_rate > 0) {
    const taxAmt = invoice.total - invoice.subtotal;
    doc.fillColor('#64748b').text(`Tax (${invoice.tax_rate}%):`, 350, y, { width: 105, align: 'right' });
    doc.fillColor('#1e293b').text(formatAmount(taxAmt), colX[3], y, { width: colW[3], align: 'right' });
    y += 16;
  }

  doc.rect(350, y - 4, 195, 24).fill('#1e293b');
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#ffffff')
    .text('TOTAL:', 355, y, { width: 100, align: 'right' })
    .text(formatAmount(invoice.total), colX[3], y, { width: colW[3], align: 'right' });

  if (invoice.notes) {
    y += 40;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#64748b').text('NOTES', 50, y);
    doc.font('Helvetica').fillColor('#475569').text(invoice.notes, 50, y + 14, { width: 400 });
  }

  doc.end();
}));

module.exports = router;
