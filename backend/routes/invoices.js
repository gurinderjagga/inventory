const express = require('express');
const PDFDocument = require('pdfkit');
const { query, runTransaction } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { companyScope, resolveCompanyId } = require('../middleware/authorize');
const { ValidationError, NotFoundError, ConflictError } = require('../lib/errors');
const v = require('../lib/validate');

const router = express.Router();
router.use(authMiddleware);

function generateInvoiceNo() {
  const now = new Date();
  const datePart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const randPart = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `INV-${datePart}-${randPart}`;
}

// GET /api/invoices  — all invoices with company name
router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await query(`
    SELECT i.*, c.name AS company_name
    FROM invoices i
    JOIN companies c ON c.id = i.company_id
    WHERE ($1::int IS NULL OR i.company_id = $1)
    ORDER BY i.created_at DESC
  `, [companyScope(req)]);
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
    WHERE ($1::int IS NULL OR company_id = $1)
  `, [companyScope(req)]);
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
    WHERE i.id = $1 AND ($2::int IS NULL OR i.company_id = $2)
  `, [id, companyScope(req)]);

  const invoice = rows[0];
  if (!invoice) throw new NotFoundError('Invoice not found');

  const lines = await query(
    'SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY id',
    [id]
  );
  invoice.line_items = lines.rows;

  res.json(invoice);
}));

// POST /api/invoices  — create draft invoice (atomic via transaction)
router.post('/', asyncHandler(async (req, res) => {
  const { company_id, customer_name, customer_email, notes, tax_rate, line_items } = req.body;

  // A company admin may omit company_id, but never name another company.
  const companyId   = resolveCompanyId(req, company_id);
  const customerNm  = v.requiredString(customer_name, 'customer_name');
  const taxRate     = v.nonNegativeNumber(tax_rate, 'Tax rate', { fallback: 0 });

  if (!Array.isArray(line_items) || line_items.length === 0) {
    throw new ValidationError('At least one line item is required');
  }

  // Normalise and validate every line before touching the database, so a bad
  // line is reported as a bad request instead of a foreign-key failure.
  const lines = line_items.map((li, idx) => {
    const label = `Line ${idx + 1}`;
    const qty   = v.nonNegativeNumber(li.quantity,   `${label} quantity`);
    if (qty <= 0) throw new ValidationError(`${label} quantity must be greater than 0`);
    return {
      itemId:    v.id(li.item_id, `${label} item_id`),
      itemName:  li.item_name,
      quantity:  qty,
      unitPrice: v.nonNegativeNumber(li.unit_price, `${label} unit price`, { fallback: 0 }),
    };
  });

  const { rows: company } = await query('SELECT id FROM companies WHERE id = $1', [companyId]);
  if (!company[0]) throw new NotFoundError('Company not found');

  // Confirm every referenced item exists AND belongs to the invoice's company,
  // and use the stored name so a client cannot mislabel a line.
  //
  // The company_id filter matters twice over: it stops one tenant billing
  // another tenant's stock, and it stops an invoice mixing items across
  // companies, which would make the stock deduction on finalize incoherent.
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

  const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
  const total    = subtotal + subtotal * (taxRate / 100);

  const invoice = await runTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO invoices (invoice_no, company_id, customer_name, customer_email, notes, subtotal, tax_rate, total, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft')
       RETURNING *`,
      [
        generateInvoiceNo(), companyId, customerNm,
        v.optionalString(customer_email), v.optionalString(notes),
        subtotal, taxRate, total,
      ]
    );
    const created = rows[0];

    for (const l of lines) {
      await client.query(
        `INSERT INTO invoice_line_items (invoice_id, item_id, item_name, quantity, unit_price, line_total)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [created.id, l.itemId, nameById.get(l.itemId), l.quantity, l.unitPrice, l.quantity * l.unitPrice]
      );
    }

    return created;
  });

  res.status(201).json(invoice);
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
      'SELECT * FROM invoices WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE',
      [id, companyScope(req)]
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
      // Atomically deduct — only updates if stock is sufficient.
      const { rowCount } = await client.query(
        `UPDATE items
         SET quantity = quantity - $1
         WHERE id = $2 AND quantity >= $3`,
        [line.quantity, line.item_id, line.quantity]
      );

      if (rowCount === 0) {
        const { rows } = await client.query(
          'SELECT name, quantity FROM items WHERE id = $1',
          [line.item_id]
        );
        const item = rows[0];
        throw new ConflictError(
          `Insufficient stock for "${item?.name || 'unknown item'}". ` +
          `Available: ${item ? item.quantity : 0}, Requested: ${line.quantity}`
        );
      }
    }

    const { rows } = await client.query(
      `UPDATE invoices SET status = 'finalized' WHERE id = $1 RETURNING *`,
      [id]
    );
    return rows[0];
  });

  res.json({ message: 'Invoice finalized and stock deducted successfully', invoice: updated });
}));

// DELETE /api/invoices/:id  — only drafts can be deleted
router.delete('/:id', asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Invoice id');

  const { rows } = await query(
    'SELECT status FROM invoices WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)',
    [id, companyScope(req)]
  );
  const invoice = rows[0];
  if (!invoice) throw new NotFoundError('Invoice not found');
  if (invoice.status === 'finalized') {
    throw new ConflictError(
      'Finalized invoices cannot be deleted — they are part of your financial record.'
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
    WHERE i.id = $1 AND ($2::int IS NULL OR i.company_id = $2)
  `, [id, companyScope(req)]);

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

  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e293b')
    .text(invoice.company_name, 300, 50, { align: 'right', width: 245 });
  doc.fontSize(9).font('Helvetica').fillColor('#64748b')
    .text(invoice.company_email || '', 300, 67, { align: 'right', width: 245 })
    .text(invoice.company_phone || '', 300, 80, { align: 'right', width: 245 })
    .text(invoice.company_address || '', 300, 93, { align: 'right', width: 245 });

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
      .text(`$${parseFloat(item.unit_price).toFixed(2)}`, colX[2], y, { width: colW[2], align: 'right' })
      .text(`$${parseFloat(item.line_total).toFixed(2)}`, colX[3], y, { width: colW[3], align: 'right' });
    y += 20;
  });

  // ── Totals ───────────────────────────────────────────────
  y += 10;
  doc.moveTo(350, y).lineTo(545, y).strokeColor('#e2e8f0').stroke();
  y += 10;

  doc.fontSize(9).fillColor('#64748b').font('Helvetica')
    .text('Subtotal:', 350, y, { width: 105, align: 'right' });
  doc.fillColor('#1e293b').text(`$${parseFloat(invoice.subtotal).toFixed(2)}`, colX[3], y, { width: colW[3], align: 'right' });
  y += 16;

  if (invoice.tax_rate > 0) {
    const taxAmt = invoice.total - invoice.subtotal;
    doc.fillColor('#64748b').text(`Tax (${invoice.tax_rate}%):`, 350, y, { width: 105, align: 'right' });
    doc.fillColor('#1e293b').text(`$${taxAmt.toFixed(2)}`, colX[3], y, { width: colW[3], align: 'right' });
    y += 16;
  }

  doc.rect(350, y - 4, 195, 24).fill('#1e293b');
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#ffffff')
    .text('TOTAL:', 355, y, { width: 100, align: 'right' })
    .text(`$${parseFloat(invoice.total).toFixed(2)}`, colX[3], y, { width: colW[3], align: 'right' });

  if (invoice.notes) {
    y += 40;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#64748b').text('NOTES', 50, y);
    doc.font('Helvetica').fillColor('#475569').text(invoice.notes, 50, y + 14, { width: 400 });
  }

  doc.end();
}));

module.exports = router;
