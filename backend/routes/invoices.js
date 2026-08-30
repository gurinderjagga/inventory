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

const router = express.Router();
router.use(authMiddleware);

function generateInvoiceNo() {
  const now = new Date();
  const datePart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const randPart = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `INV-${datePart}-${randPart}`;
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

  // Use the stored name so a client cannot mislabel a line.
  const ids = [...new Set(lines.map(l => l.itemId))];
  const { rows: found } = await query(
    'SELECT id, name FROM items WHERE id = ANY($1::int[]) AND company_id = $2',
    [ids, companyId]
  );
  const nameById = new Map(found.map(r => [r.id, r.name]));
  const missing  = ids.filter(id => !nameById.has(id));
  if (missing.length) {
    throw new ValidationError(
      `No such item${missing.length === 1 ? '' : 's'} for this company: ${missing.join(', ')}`
    );
  }

  return lines.map(l => ({ ...l, itemName: nameById.get(l.itemId) }));
}

/**
 * Money totals for a set of normalised lines.
 *
 * Every step goes through lib/money.js rather than JavaScript arithmetic: the
 * old version computed `quantity * unitPrice` on doubles, so a three-line
 * invoice could store a total a paisa away from the sum of its own printed
 * lines. The subtotal is the sum of the ROUNDED line totals, deliberately —
 * that is the figure each line shows, and an invoice whose lines do not add up
 * to its total is indefensible in front of an auditor.
 */
function invoiceTotals(lines, taxRate) {
  const subtotal = money.sum(lines.map(l => money.lineTotal(l.quantity, l.unitPrice)));
  const tax      = money.taxOn(subtotal, taxRate);
  return { subtotal, total: money.sum([subtotal, tax]) };
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

/** Write the line items of an invoice, replacing whatever is already there. */
async function writeLines(client, invoiceId, lines) {
  await client.query('DELETE FROM invoice_line_items WHERE invoice_id = $1', [invoiceId]);
  for (const l of lines) {
    await client.query(
      `INSERT INTO invoice_line_items (invoice_id, item_id, item_name, quantity, unit_price, line_total)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        invoiceId, l.itemId, l.itemName,
        money.quantity(l.quantity), money.money(l.unitPrice),
        money.lineTotal(l.quantity, l.unitPrice),
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

  if (!isBlank(customer_id)) {
    customerId = v.id(customer_id, 'customer_id');
    const { rows } = await query(
      'SELECT id, name FROM customers WHERE id = $1 AND company_id = $2',
      [customerId, companyId]
    );
    if (!rows[0]) throw new ValidationError('No such customer for this company');
    name = name || rows[0].name;
  }

  if (!name) throw new ValidationError('customer_name is required');
  return { customerId, name, email: v.optionalString(customer_email) };
}

/**
 * Freeze the supplier's own GST identity onto the invoice at issue — a company
 * that later registers, or moves state, must not retroactively change a
 * document already sent. Also enforces that only a registered supplier may
 * charge tax at all (Section 122); the database's own CHECK backs this up.
 */
function snapshotSupplier(company, taxRate) {
  if (taxRate > 0 && !company.gstin) {
    throw new ValidationError('Cannot charge tax without a supplier GSTIN');
  }
  return {
    gstin:     company.gstin || null,
    name:      company.legal_name || company.name,
    address:   company.address || null,
    stateCode: company.state_code || null,
  };
}

// POST /api/invoices  — create draft invoice (atomic via transaction)
router.post('/', asyncHandler(async (req, res) => {
  const { company_id, notes, tax_rate, line_items } = req.body;

  const companyId   = v.id(company_id, 'company_id');
  const taxRate     = v.nonNegativeNumber(tax_rate, 'Tax rate', { fallback: 0 });

  const { rows: company } = await query('SELECT * FROM companies WHERE id = $1', [companyId]);
  if (!company[0]) throw new NotFoundError('Company not found');

  const customer = await resolveCustomer(companyId, req.body);
  const supplier = snapshotSupplier(company[0], taxRate);
  const lines = await normalizeLines(companyId, line_items);
  const { subtotal, total } = invoiceTotals(lines, taxRate);

  const invoice = await runTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO invoices
         (invoice_no, company_id, customer_id, customer_name, customer_email, notes,
          subtotal, tax_rate, total, status,
          supplier_gstin, supplier_name, supplier_address, supplier_state_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', $10, $11, $12, $13)
       RETURNING *`,
      [
        generateInvoiceNo(), companyId, customer.customerId, customer.name,
        customer.email, v.optionalString(notes),
        subtotal, taxRate, total,
        supplier.gstin, supplier.name, supplier.address, supplier.stateCode,
      ]
    );
    const created = rows[0];
    await writeLines(client, created.id, lines);
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
  const { notes, tax_rate, line_items } = req.body;

  const taxRate    = v.nonNegativeNumber(tax_rate, 'Tax rate', { fallback: 0 });

  const { rows: existing } = await query(
    'SELECT id, company_id, status FROM invoices WHERE id = $1',
    [id]
  );
  const current = existing[0];
  if (!current) throw new NotFoundError('Invoice not found');
  assertIsDraft(current.status, 'edited');

  // The company itself is immutable on edit, but the GSTIN-vs-tax rule is
  // re-checked here too: tax_rate can change on a draft, and the supplier
  // snapshot taken at creation must still justify it.
  const { rows: company } = await query('SELECT * FROM companies WHERE id = $1', [current.company_id]);
  snapshotSupplier(company[0], taxRate);

  const customer = await resolveCustomer(current.company_id, req.body);
  const lines = await normalizeLines(current.company_id, line_items);
  const { subtotal, total } = invoiceTotals(lines, taxRate);

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
           subtotal = $5, tax_rate = $6, total = $7, updated_at = now()
       WHERE id = $8
       RETURNING *`,
      [
        customer.customerId, customer.name, customer.email, v.optionalString(notes),
        subtotal, taxRate, total, id,
      ]
    );
    await writeLines(client, id, lines);
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

    const { rows } = await client.query(
      `UPDATE invoices SET status = 'finalized' WHERE id = $1 RETURNING *`,
      [id]
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

  if (invoice.tax_rate > 0) {
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
