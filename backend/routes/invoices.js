/**
 * routes/invoices.js
 *
 * GST tax invoices — draft, finalize, reverse. Every route is gated by
 * requireCompanyAccess (is this your company?) and requireFeature('invoicing', ...)
 * (has an admin turned this on for that company?), same two-step every
 * company-scoped resource in this app already uses.
 *
 * Legal grounding: fields and computation follow CGST Rule 46 (the mandatory
 * particulars of a tax invoice) and the CGST/IGST Acts' place-of-supply test
 * for CGST+SGST vs IGST. This does NOT implement government e-invoicing
 * (IRN/QR from the GST Invoice Registration Portal) — that needs a live
 * GSP/IRP integration with real GSTIN-linked credentials this install does
 * not have, and only applies above certain turnover thresholds anyway.
 *
 * A draft is not yet a legal document, so it is deliberately editable and
 * its totals are only a preview. The supplier snapshot and final numbering
 * are (re)applied at FINALIZE — the moment the document actually comes into
 * legal existence — using the company's data as it stands *then*, not
 * whatever it was when the draft happened to be created or last edited.
 */
const express = require('express');
const PDFDocument = require('pdfkit');
const { query, runTransaction, PG_UNIQUE_VIOLATION } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');
const { requireCompanyAccess, requireFeature } = require('../middleware/rbac');
const { asyncHandler } = require('../middleware/asyncHandler');
const { NotFoundError, ConflictError, ValidationError } = require('../lib/errors');
const v = require('../lib/validate');
const money = require('../lib/money');
const gst = require('../lib/gst');
const { formatAmount } = require('../lib/currency');
const { applyMovement } = require('../lib/stockLedger');

const router = express.Router();
router.use(authMiddleware);

const FEATURE_KEY    = 'invoicing';
const DOCUMENT_TYPE  = 'invoice';

/** Resolve the company an existing invoice belongs to, for the RBAC gates. */
async function companyIdForInvoice(req) {
  const { rows } = await query(
    'SELECT company_id FROM invoices WHERE id = $1',
    [v.id(req.params.id, 'Invoice id')]
  );
  return rows[0]?.company_id;
}

const gate = (getCompanyId) => [requireCompanyAccess(getCompanyId), requireFeature(FEATURE_KEY, getCompanyId)];

/** A short, obviously-not-a-real-number placeholder so drafts never burn a real sequence slot. */
function randomPlaceholderNumber() {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand  = Math.floor(1000 + Math.random() * 9000);
  return `INV-${stamp}-${rand}`;
}

/** Read and validate the bill-to payload shared by POST and PUT. */
function readBillTo(body) {
  return {
    customerName:      v.requiredString(body.customer_name, 'Customer name'),
    customerEmail:     v.optionalString(body.customer_email),
    customerAddress:   v.requiredString(body.customer_address, 'Customer address'),
    customerGstin:     v.gstin(body.customer_gstin),
    customerStateCode: v.optionalString(body.customer_state_code),
    deliveryAddress:   v.optionalString(body.delivery_address),
    reverseCharge:     v.boolean(body.reverse_charge),
    notes:             v.optionalString(body.notes),
  };
}

/**
 * Whether a company charges tax at all, and — if it does — that the place of
 * supply is known so the CGST+SGST/IGST split can be computed.
 *
 * Only a GST-registered company on the regular scheme may charge tax
 * (Section 10, CGST Act rules composition dealers out; an unregistered
 * company has no GSTIN to charge under). This is the statutory rule itself,
 * not a simplification of it.
 */
function taxContext(company, customerStateCode) {
  const chargesTax = !!company.gstin && company.scheme === 'regular';
  if (chargesTax && !customerStateCode) {
    throw new ValidationError('Customer state is required to compute tax for a GST-registered company');
  }
  return { chargesTax, intraState: chargesTax && customerStateCode === company.state_code };
}

/**
 * Re-derive each line's item_name/HSN/UQC/GST rate from the database, scoped
 * to company_id — never trust client-supplied item data, and never let one
 * company bill against another's items.
 */
async function normalizeLines(companyId, rawLines) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new ValidationError('At least one line item is required');
  }
  const itemIds = rawLines.map((l) => v.id(l.item_id, 'item_id'));
  const { rows: items } = await query(
    'SELECT id, name, hsn_sac_code, uqc, gst_rate FROM items WHERE company_id = $1 AND id = ANY($2)',
    [companyId, itemIds]
  );
  const byId = new Map(items.map((i) => [i.id, i]));

  return rawLines.map((line) => {
    const itemId = v.id(line.item_id, 'item_id');
    const item = byId.get(itemId);
    if (!item) throw new NotFoundError(`Item ${itemId} not found for this company`);

    const quantity = money.quantity(v.nonNegativeNumber(line.quantity, 'Quantity'));
    if (money.dec(quantity).isZero()) throw new ValidationError('Line quantity must be greater than zero');
    const unitPrice = money.money(v.nonNegativeNumber(line.unit_price, 'Unit price'));

    return {
      itemId, itemName: item.name, hsnSacCode: item.hsn_sac_code, uqc: item.uqc,
      gstRate: item.gst_rate, quantity, unitPrice,
      lineTotal: money.lineTotal(quantity, unitPrice),
    };
  });
}

/**
 * Per-line tax plus invoice-level totals. Subtotal is the sum of already-
 * rounded line totals (never a rounded sum of unrounded ones — lib/money.js's
 * policy), and the whole-rupee round-off only applies once tax is actually
 * nonzero, so an untaxed invoice stays paisa-exact.
 */
function invoiceTotals(lines, { chargesTax, intraState }) {
  const lineTaxes = lines.map((line) =>
    chargesTax
      ? gst.computeLineTax(line.lineTotal, line.gstRate, intraState)
      : { cgst: '0.00', sgst: '0.00', igst: '0.00' }
  );

  const subtotal   = money.sum(lines.map((l) => l.lineTotal));
  const cgstTotal  = money.sum(lineTaxes.map((t) => t.cgst));
  const sgstTotal  = money.sum(lineTaxes.map((t) => t.sgst));
  const igstTotal  = money.sum(lineTaxes.map((t) => t.igst));
  const hasTax     = !money.dec(cgstTotal).plus(sgstTotal).plus(igstTotal).isZero();
  const preRound   = money.dec(subtotal).plus(cgstTotal).plus(sgstTotal).plus(igstTotal);

  const { total, roundOff } = hasTax
    ? gst.roundToRupee(preRound)
    : { total: money.money(preRound), roundOff: '0.00' };

  return { lineTaxes, subtotal, cgstTotal, sgstTotal, igstTotal, total, roundOff };
}

/** The supplier block as it stands right now — applied fresh at every write. */
function snapshotSupplier(company) {
  return {
    gstin: company.gstin,
    name: company.legal_name || company.name,
    address: company.address,
    stateCode: company.state_code,
    scheme: company.scheme,
    signatoryName: company.authorized_signatory_name,
  };
}

/**
 * Atomically allocate the next sequential number for a company/document
 * type/financial year. A single INSERT ... ON CONFLICT DO UPDATE avoids a
 * separate SELECT FOR UPDATE: the VALUES(...,1) branch handles a series'
 * first-ever allocation, the DO UPDATE branch increments and returns the
 * next one — either way, RETURNING hands back the number just allocated.
 */
async function allocateInvoiceNumber(client, companyId, documentType = DOCUMENT_TYPE) {
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

// ── GET /company/:companyId/summary — dashboard aggregate ───────────────────
router.get('/company/:companyId/summary', ...gate(req => req.params.companyId), asyncHandler(async (req, res) => {
  const companyId = v.id(req.params.companyId, 'Company id');
  const { rows } = await query(
    `SELECT
       COUNT(*)::int AS total_invoices,
       COUNT(*) FILTER (WHERE status = 'draft')::int AS draft_count,
       COALESCE(SUM(total) FILTER (WHERE status = 'finalized'), 0) AS finalized_revenue
     FROM invoices WHERE company_id = $1`,
    [companyId]
  );
  res.json(rows[0]);
}));

// ── GET /company/:companyId — paginated list ─────────────────────────────────
router.get('/company/:companyId', ...gate(req => req.params.companyId), asyncHandler(async (req, res) => {
  const companyId = v.id(req.params.companyId, 'Company id');
  const page      = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit     = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset    = (page - 1) * limit;

  const { rows } = await query(
    `SELECT id, invoice_no, customer_name, subtotal, total, status, created_at
     FROM invoices WHERE company_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [companyId, limit, offset]
  );
  const { rows: countRows } = await query(
    'SELECT COUNT(*)::int AS total FROM invoices WHERE company_id = $1', [companyId]
  );

  res.json({
    invoices: rows, total: countRows[0].total, page, limit,
    pages: Math.ceil(countRows[0].total / limit),
  });
}));

// ── GET /:id — one invoice, with its line items ──────────────────────────────
router.get('/:id', ...gate(companyIdForInvoice), asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Invoice id');
  const { rows } = await query('SELECT * FROM invoices WHERE id = $1', [id]);
  if (!rows[0]) throw new NotFoundError('Invoice not found');
  const { rows: lines } = await query(
    'SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY id', [id]
  );
  res.json({ ...rows[0], line_items: lines });
}));

// ── POST / — create a draft ──────────────────────────────────────────────────
router.post('/', ...gate(req => req.body.company_id), asyncHandler(async (req, res) => {
  const companyId = v.id(req.body.company_id, 'company_id');
  const billTo    = readBillTo(req.body);

  const { rows: companies } = await query('SELECT * FROM companies WHERE id = $1', [companyId]);
  const company = companies[0];
  if (!company) throw new NotFoundError('Company not found');

  const { chargesTax, intraState } = taxContext(company, billTo.customerStateCode);
  const lines    = await normalizeLines(companyId, req.body.line_items);
  const totals   = invoiceTotals(lines, { chargesTax, intraState });
  const supplier = snapshotSupplier(company);

  const created = await runTransaction(async (client) => {
    let invoice;
    try {
      const { rows: invRows } = await client.query(
        `INSERT INTO invoices (
           invoice_no, company_id, customer_name, customer_email, customer_address,
           customer_gstin, customer_state_code, delivery_address, reverse_charge, notes,
           subtotal, total, status,
           supplier_gstin, supplier_name, supplier_address, supplier_state_code,
           supplier_scheme, supplier_signatory_name, place_of_supply_state,
           cgst_total, sgst_total, igst_total, round_off
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft',
                   $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         RETURNING *`,
        [
          randomPlaceholderNumber(), companyId, billTo.customerName, billTo.customerEmail, billTo.customerAddress,
          billTo.customerGstin, billTo.customerStateCode, billTo.deliveryAddress, billTo.reverseCharge, billTo.notes,
          totals.subtotal, totals.total,
          supplier.gstin, supplier.name, supplier.address, supplier.stateCode,
          supplier.scheme, supplier.signatoryName, billTo.customerStateCode,
          totals.cgstTotal, totals.sgstTotal, totals.igstTotal, totals.roundOff,
        ]
      );
      invoice = invRows[0];
    } catch (err) {
      if (err.code === PG_UNIQUE_VIOLATION) {
        throw new ConflictError('Could not allocate a draft number — please try again');
      }
      throw err;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const tax  = totals.lineTaxes[i];
      await client.query(
        `INSERT INTO invoice_line_items
           (invoice_id, item_id, item_name, quantity, unit_price, line_total,
            hsn_sac_code, uqc, gst_rate, cgst_amount, sgst_amount, igst_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [invoice.id, line.itemId, line.itemName, line.quantity, line.unitPrice, line.lineTotal,
          line.hsnSacCode, line.uqc, line.gstRate, tax.cgst, tax.sgst, tax.igst]
      );
    }
    return invoice;
  });

  res.status(201).json(created);
}));

// ── PUT /:id — edit a draft only; company_id is immutable ────────────────────
router.put('/:id', ...gate(companyIdForInvoice), asyncHandler(async (req, res) => {
  const id     = v.id(req.params.id, 'Invoice id');
  const billTo = readBillTo(req.body);

  const updated = await runTransaction(async (client) => {
    const { rows: existingRows } = await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [id]);
    const existing = existingRows[0];
    if (!existing) throw new NotFoundError('Invoice not found');
    if (existing.status !== 'draft') throw new ConflictError('Only a draft can be edited');

    const { rows: companyRows } = await client.query('SELECT * FROM companies WHERE id = $1', [existing.company_id]);
    const company = companyRows[0];

    const { chargesTax, intraState } = taxContext(company, billTo.customerStateCode);
    const lines    = await normalizeLines(existing.company_id, req.body.line_items);
    const totals   = invoiceTotals(lines, { chargesTax, intraState });
    const supplier = snapshotSupplier(company);

    await client.query('DELETE FROM invoice_line_items WHERE invoice_id = $1', [id]);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const tax  = totals.lineTaxes[i];
      await client.query(
        `INSERT INTO invoice_line_items
           (invoice_id, item_id, item_name, quantity, unit_price, line_total,
            hsn_sac_code, uqc, gst_rate, cgst_amount, sgst_amount, igst_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, line.itemId, line.itemName, line.quantity, line.unitPrice, line.lineTotal,
          line.hsnSacCode, line.uqc, line.gstRate, tax.cgst, tax.sgst, tax.igst]
      );
    }

    const { rows: updatedRows } = await client.query(
      `UPDATE invoices SET
         customer_name=$1, customer_email=$2, customer_address=$3, customer_gstin=$4,
         customer_state_code=$5, delivery_address=$6, reverse_charge=$7, notes=$8,
         subtotal=$9, cgst_total=$10, sgst_total=$11, igst_total=$12, total=$13, round_off=$14,
         supplier_gstin=$15, supplier_name=$16, supplier_address=$17, supplier_state_code=$18,
         supplier_scheme=$19, supplier_signatory_name=$20, place_of_supply_state=$21,
         updated_at = now()
       WHERE id = $22
       RETURNING *`,
      [billTo.customerName, billTo.customerEmail, billTo.customerAddress, billTo.customerGstin,
        billTo.customerStateCode, billTo.deliveryAddress, billTo.reverseCharge, billTo.notes,
        totals.subtotal, totals.cgstTotal, totals.sgstTotal, totals.igstTotal, totals.total, totals.roundOff,
        supplier.gstin, supplier.name, supplier.address, supplier.stateCode,
        supplier.scheme, supplier.signatoryName, billTo.customerStateCode, id]
    );
    return updatedRows[0];
  });

  res.json(updated);
}));

// ── POST /:id/finalize — the moment the document becomes a legal record ─────
router.post('/:id/finalize', ...gate(companyIdForInvoice), asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Invoice id');

  const finalized = await runTransaction(async (client) => {
    const { rows: invRows } = await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [id]);
    const invoice = invRows[0];
    if (!invoice) throw new NotFoundError('Invoice not found');
    if (invoice.status !== 'draft') {
      throw new ConflictError(`Only a draft can be finalized — this invoice is already ${invoice.status}`);
    }

    const { rows: companyRows } = await client.query('SELECT * FROM companies WHERE id = $1', [invoice.company_id]);
    const company = companyRows[0];

    const { rows: lineRows } = await client.query(
      'SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY id', [id]
    );
    const lines = lineRows.map((r) => ({
      itemId: r.item_id, gstRate: r.gst_rate, quantity: r.quantity, lineTotal: r.line_total,
    }));

    // Re-checked against the company's CURRENT registration, not whatever it
    // was when the draft was last saved — this is the point the document
    // legally comes into existence, so this is what has to be accurate.
    const { chargesTax, intraState } = taxContext(company, invoice.customer_state_code);
    const totals   = invoiceTotals(lines, { chargesTax, intraState });
    const supplier = snapshotSupplier(company);
    const invoiceNo = await allocateInvoiceNumber(client, invoice.company_id);

    for (let i = 0; i < lineRows.length; i++) {
      const tax = totals.lineTaxes[i];
      await client.query(
        'UPDATE invoice_line_items SET cgst_amount=$1, sgst_amount=$2, igst_amount=$3 WHERE id=$4',
        [tax.cgst, tax.sgst, tax.igst, lineRows[i].id]
      );
    }

    // Stock deduction and the invoice row update happen in the same
    // transaction: if any line is short on stock, applyMovement throws and
    // the whole finalize — numbering included — rolls back.
    for (const line of lines) {
      await applyMovement(client, {
        itemId: line.itemId, companyId: invoice.company_id,
        delta: money.dec(line.quantity).negated().toString(),
        reason: 'invoice_finalize', invoiceId: id, userId: req.user.id,
      });
    }

    const { rows: updatedRows } = await client.query(
      `UPDATE invoices SET
         invoice_no=$1, status='finalized',
         subtotal=$2, cgst_total=$3, sgst_total=$4, igst_total=$5, total=$6, round_off=$7,
         supplier_gstin=$8, supplier_name=$9, supplier_address=$10, supplier_state_code=$11,
         supplier_scheme=$12, supplier_signatory_name=$13, place_of_supply_state=$14,
         updated_at = now()
       WHERE id = $15
       RETURNING *`,
      [invoiceNo, totals.subtotal, totals.cgstTotal, totals.sgstTotal, totals.igstTotal, totals.total, totals.roundOff,
        supplier.gstin, supplier.name, supplier.address, supplier.stateCode,
        supplier.scheme, supplier.signatoryName, invoice.customer_state_code, id]
    );
    return updatedRows[0];
  });

  res.json(finalized);
}));

// ── POST /:id/reverse — restore stock, close the document out ───────────────
router.post('/:id/reverse', ...gate(companyIdForInvoice), asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Invoice id');

  const reversed = await runTransaction(async (client) => {
    const { rows: invRows } = await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [id]);
    const invoice = invRows[0];
    if (!invoice) throw new NotFoundError('Invoice not found');
    if (invoice.status === 'draft')    throw new ConflictError('A draft has not been finalized — there is nothing to reverse');
    if (invoice.status === 'reversed') throw new ConflictError('This invoice has already been reversed');

    const { rows: lineRows } = await client.query(
      'SELECT item_id, quantity FROM invoice_line_items WHERE invoice_id = $1', [id]
    );
    for (const line of lineRows) {
      await applyMovement(client, {
        itemId: line.item_id, companyId: invoice.company_id,
        delta: line.quantity, reason: 'invoice_reversal', invoiceId: id, userId: req.user.id,
      });
    }

    const { rows: updatedRows } = await client.query(
      `UPDATE invoices SET status='reversed', updated_at = now() WHERE id = $1 RETURNING *`, [id]
    );
    return updatedRows[0];
  });

  res.json(reversed);
}));

// ── DELETE /:id — drafts only ────────────────────────────────────────────────
router.delete('/:id', ...gate(companyIdForInvoice), asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Invoice id');
  const { rows } = await query('SELECT status FROM invoices WHERE id = $1', [id]);
  if (!rows[0]) throw new NotFoundError('Invoice not found');
  if (rows[0].status !== 'draft') {
    throw new ConflictError('Only a draft can be deleted — a finalized invoice is a financial record');
  }
  await query('DELETE FROM invoices WHERE id = $1', [id]);
  res.json({ message: 'Draft deleted' });
}));

// ── GET /:id/pdf ──────────────────────────────────────────────────────────────
router.get('/:id/pdf', ...gate(companyIdForInvoice), asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Invoice id');
  const { rows } = await query('SELECT * FROM invoices WHERE id = $1', [id]);
  const invoice = rows[0];
  if (!invoice) throw new NotFoundError('Invoice not found');
  const { rows: lines } = await query(
    'SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY id', [id]
  );

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${invoice.invoice_no.replace(/\//g, '-')}.pdf"`);

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);
  renderInvoicePdf(doc, invoice, lines);
  doc.end();
}));

/**
 * Manual x/y layout — pdfkit has no built-in table. Carries every field
 * CGST Rule 46 requires: supplier & recipient GSTIN/address, HSN per line,
 * quantity+UQC, taxable value, tax rate/amount per head, place of supply,
 * delivery address (if different), the reverse-charge declaration, and a
 * signatory line (see the module doc comment — no real DSC integration).
 */
function renderInvoicePdf(doc, invoice, lines) {
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const left = doc.page.margins.left;

  doc.fontSize(18).font('Helvetica-Bold').text('TAX INVOICE', { align: 'center' });
  doc.moveDown(0.6);

  doc.fontSize(9).font('Helvetica');
  const dateStr = new Date(invoice.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  doc.text(`Invoice No: ${invoice.invoice_no}`, left, doc.y, { width: pageWidth / 2 });
  doc.text(`Date: ${dateStr}`, left + pageWidth / 2, doc.y - doc.currentLineHeight(), { width: pageWidth / 2, align: 'right' });
  doc.moveDown(1);

  // ── Supplier / recipient two-column block ──────────────────────────────
  const colWidth = pageWidth / 2 - 10;
  const toX = left + colWidth + 20;
  const topY = doc.y;

  doc.font('Helvetica-Bold').text('FROM', left, topY, { width: colWidth });
  doc.font('Helvetica');
  doc.text(invoice.supplier_name || '-', left, doc.y, { width: colWidth });
  doc.text(invoice.supplier_address || '-', left, doc.y, { width: colWidth });
  if (invoice.supplier_gstin) doc.text(`GSTIN: ${invoice.supplier_gstin}`, left, doc.y, { width: colWidth });
  if (invoice.supplier_state_code) doc.text(`State Code: ${invoice.supplier_state_code}`, left, doc.y, { width: colWidth });
  const fromBottomY = doc.y;

  doc.font('Helvetica-Bold').text('BILL TO', toX, topY, { width: colWidth });
  doc.font('Helvetica');
  doc.text(invoice.customer_name || '-', toX, doc.y, { width: colWidth });
  doc.text(invoice.customer_address || '-', toX, doc.y, { width: colWidth });
  if (invoice.customer_gstin) doc.text(`GSTIN: ${invoice.customer_gstin}`, toX, doc.y, { width: colWidth });
  doc.text(`Place of Supply: ${invoice.place_of_supply_state || '-'}`, toX, doc.y, { width: colWidth });
  const toBottomY = doc.y;

  doc.y = Math.max(fromBottomY, toBottomY) + 10;

  if (invoice.delivery_address) {
    doc.font('Helvetica-Bold').text('Delivery Address: ', left, doc.y, { continued: true });
    doc.font('Helvetica').text(invoice.delivery_address);
  }
  doc.font('Helvetica-Bold').text('Reverse Charge Applicable: ', left, doc.y, { continued: true });
  doc.font('Helvetica').text(invoice.reverse_charge ? 'Yes' : 'No');
  doc.moveDown(0.8);

  // ── Line items table ────────────────────────────────────────────────────
  const cols = [
    { label: '#',       width: 18,  key: 'idx',   align: 'left' },
    { label: 'Item',    width: 118, key: 'name',  align: 'left' },
    { label: 'HSN/SAC', width: 52,  key: 'hsn',   align: 'left' },
    { label: 'Qty',     width: 48,  key: 'qty',   align: 'right' },
    { label: 'Rate',    width: 55,  key: 'price', align: 'right' },
    { label: 'Taxable', width: 62,  key: 'total', align: 'right' },
    { label: 'CGST',    width: 42,  key: 'cgst',  align: 'right' },
    { label: 'SGST',    width: 42,  key: 'sgst',  align: 'right' },
    { label: 'IGST',    width: 42,  key: 'igst',  align: 'right' },
  ];

  doc.font('Helvetica-Bold').fontSize(8);
  let x = left;
  const headerY = doc.y;
  for (const col of cols) {
    doc.text(col.label, x, headerY, { width: col.width, align: col.align });
    x += col.width;
  }
  doc.moveDown(0.4);
  doc.moveTo(left, doc.y).lineTo(left + pageWidth, doc.y).stroke();
  doc.moveDown(0.3);

  doc.font('Helvetica').fontSize(8);
  lines.forEach((line, i) => {
    const rowY = doc.y;
    const values = {
      idx: String(i + 1),
      name: line.item_name,
      hsn: line.hsn_sac_code || '-',
      qty: `${Number(line.quantity)}${line.uqc ? ' ' + line.uqc : ''}`,
      price: formatAmount(line.unit_price),
      total: formatAmount(line.line_total),
      cgst: formatAmount(line.cgst_amount),
      sgst: formatAmount(line.sgst_amount),
      igst: formatAmount(line.igst_amount),
    };
    let cx = left;
    for (const col of cols) {
      doc.text(values[col.key], cx, rowY, { width: col.width, align: col.align });
      cx += col.width;
    }
    doc.moveDown(0.5);
  });

  doc.moveTo(left, doc.y).lineTo(left + pageWidth, doc.y).stroke();
  doc.moveDown(0.6);

  // ── Totals ──────────────────────────────────────────────────────────────
  doc.fontSize(9);
  const totalsX = left + pageWidth - 200;
  const totalLine = (label, value, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
    doc.text(label, totalsX, doc.y, { width: 120, continued: true });
    doc.text(value, { width: 80, align: 'right' });
  };
  totalLine('Subtotal', formatAmount(invoice.subtotal));
  if (Number(invoice.cgst_total) > 0) totalLine('CGST', formatAmount(invoice.cgst_total));
  if (Number(invoice.sgst_total) > 0) totalLine('SGST', formatAmount(invoice.sgst_total));
  if (Number(invoice.igst_total) > 0) totalLine('IGST', formatAmount(invoice.igst_total));
  if (Number(invoice.round_off) !== 0) totalLine('Round Off', formatAmount(invoice.round_off));
  totalLine('Total', formatAmount(invoice.total), true);
  doc.moveDown(1);

  if (invoice.notes) {
    doc.fontSize(9).font('Helvetica-Bold').text('Notes:', left, doc.y);
    doc.font('Helvetica').text(invoice.notes, left, doc.y, { width: pageWidth });
    doc.moveDown(1);
  }

  // ── Signatory ─────────────────────────────────────────────────────────
  doc.moveDown(1.5);
  const signX = left + pageWidth - 180;
  doc.fontSize(9).text(`For ${invoice.supplier_name || ''}`, signX, doc.y, { width: 180, align: 'center' });
  doc.moveDown(2.2);
  doc.text(invoice.supplier_signatory_name || 'Authorized Signatory', signX, doc.y, { width: 180, align: 'center' });
  doc.fontSize(7).text('Authorized Signatory', signX, doc.y, { width: 180, align: 'center' });

  doc.fontSize(7).text(
    'This is a system-generated invoice.',
    left, doc.page.height - doc.page.margins.bottom - 20,
    { width: pageWidth, align: 'center' }
  );
}

module.exports = router;
