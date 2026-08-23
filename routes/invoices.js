const express = require('express');
const PDFDocument = require('pdfkit');
const { getDB, runTransaction } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

function generateInvoiceNo() {
  const now = new Date();
  const datePart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const randPart = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `INV-${datePart}-${randPart}`;
}

// GET /api/invoices  — all invoices with company name
router.get('/', (req, res) => {
  const db = getDB();
  const invoices = db.prepare(`
    SELECT i.*, c.name AS company_name
    FROM invoices i
    JOIN companies c ON c.id = i.company_id
    ORDER BY i.created_at DESC
  `).all();
  res.json(invoices);
});

// GET /api/invoices/summary/stats  — dashboard summary (MUST be before /:id)
router.get('/summary/stats', (req, res) => {
  const db = getDB();
  const totalInvoices = db.prepare("SELECT COUNT(*) AS count FROM invoices").get().count;
  const totalRevenue  = db.prepare("SELECT COALESCE(SUM(total), 0) AS sum FROM invoices WHERE status = 'finalized'").get().sum;
  const draftCount    = db.prepare("SELECT COUNT(*) AS count FROM invoices WHERE status = 'draft'").get().count;
  res.json({ totalInvoices, totalRevenue, draftCount });
});

// GET /api/invoices/:id  — invoice + line items
router.get('/:id', (req, res) => {
  const db = getDB();
  const invoice = db.prepare(`
    SELECT i.*, c.name AS company_name, c.email AS company_email,
           c.phone AS company_phone, c.address AS company_address
    FROM invoices i
    JOIN companies c ON c.id = i.company_id
    WHERE i.id = ?
  `).get(req.params.id);

  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  invoice.line_items = db.prepare(
    'SELECT * FROM invoice_line_items WHERE invoice_id = ? ORDER BY id'
  ).all(req.params.id);

  res.json(invoice);
});

// POST /api/invoices  — create draft invoice (atomic via transaction)
router.post('/', (req, res) => {
  const { company_id, customer_name, customer_email, notes, tax_rate, line_items } = req.body;

  if (!company_id) return res.status(400).json({ error: 'company_id is required' });
  if (!customer_name?.trim()) return res.status(400).json({ error: 'customer_name is required' });
  if (!Array.isArray(line_items) || line_items.length === 0) {
    return res.status(400).json({ error: 'At least one line item is required' });
  }

  const db = getDB();
  const invoice_no = generateInvoiceNo();
  const taxRate = parseFloat(tax_rate) || 0;

  let subtotal = 0;
  for (const li of line_items) {
    if (!li.item_id || li.quantity <= 0) {
      return res.status(400).json({ error: 'Each line item needs a valid item_id and quantity > 0' });
    }
    subtotal += parseFloat(li.quantity) * parseFloat(li.unit_price);
  }
  const tax   = subtotal * (taxRate / 100);
  const total = subtotal + tax;

  try {
    const invoiceId = runTransaction(() => {
      const result = db.prepare(`
        INSERT INTO invoices (invoice_no, company_id, customer_name, customer_email, notes, subtotal, tax_rate, total, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')
      `).run(invoice_no, company_id, customer_name.trim(), customer_email || null, notes || null, subtotal, taxRate, total);

      const insertLine = db.prepare(`
        INSERT INTO invoice_line_items (invoice_id, item_id, item_name, quantity, unit_price, line_total)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const li of line_items) {
        insertLine.run(
          result.lastInsertRowid,
          li.item_id,
          li.item_name,
          parseFloat(li.quantity),
          parseFloat(li.unit_price),
          parseFloat(li.quantity) * parseFloat(li.unit_price)
        );
      }

      return result.lastInsertRowid;
    });

    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    res.status(201).json(invoice);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

// POST /api/invoices/:id/finalize  — atomic stock deduction
router.post('/:id/finalize', (req, res) => {
  const db = getDB();
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);

  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.status === 'finalized') {
    return res.status(400).json({ error: 'This invoice has already been finalized' });
  }

  const lineItems = db.prepare(
    'SELECT * FROM invoice_line_items WHERE invoice_id = ?'
  ).all(req.params.id);

  if (lineItems.length === 0) {
    return res.status(400).json({ error: 'Invoice has no line items' });
  }

  try {
    // runTransaction rolls back automatically if ANY error is thrown
    const updated = runTransaction(() => {
      for (const line of lineItems) {
        // Atomically deduct — only updates if stock is sufficient
        const result = db.prepare(`
          UPDATE items
          SET quantity = quantity - ?
          WHERE id = ? AND quantity >= ?
        `).run(line.quantity, line.item_id, line.quantity);

        if (result.changes === 0) {
          const item = db.prepare('SELECT name, quantity FROM items WHERE id = ?').get(line.item_id);
          const available = item ? item.quantity : 0;
          throw new Error(
            `Insufficient stock for "${item?.name || 'unknown item'}". ` +
            `Available: ${available}, Requested: ${line.quantity}`
          );
        }
      }

      db.prepare("UPDATE invoices SET status = 'finalized' WHERE id = ?").run(req.params.id);
      return db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    });

    res.json({ message: 'Invoice finalized and stock deducted successfully', invoice: updated });
  } catch (err) {
    // Transaction was rolled back — stock is unchanged
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/invoices/:id  — only drafts can be deleted
router.delete('/:id', (req, res) => {
  const db = getDB();
  const invoice = db.prepare('SELECT status FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.status === 'finalized') {
    return res.status(400).json({ error: 'Finalized invoices cannot be deleted' });
  }
  db.prepare('DELETE FROM invoices WHERE id = ?').run(req.params.id);
  res.json({ message: 'Invoice deleted' });
});

// GET /api/invoices/:id/pdf  — stream PDF download
router.get('/:id/pdf', (req, res) => {
  const db = getDB();
  const invoice = db.prepare(`
    SELECT i.*, c.name AS company_name, c.email AS company_email,
           c.phone AS company_phone, c.address AS company_address
    FROM invoices i
    JOIN companies c ON c.id = i.company_id
    WHERE i.id = ?
  `).get(req.params.id);

  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  const lineItems = db.prepare(
    'SELECT * FROM invoice_line_items WHERE invoice_id = ? ORDER BY id'
  ).all(req.params.id);

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${invoice.invoice_no}.pdf"`);
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
});

module.exports = router;
