const express = require('express');
const { getDB } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// GET /api/companies  — all companies with item + low stock counts
router.get('/', (req, res) => {
  try {
    const db = getDB();
    const companies = db.prepare(`
      SELECT
        c.*,
        COUNT(i.id)                                                        AS item_count,
        SUM(CASE WHEN i.quantity <= i.low_stock_threshold THEN 1 ELSE 0 END) AS low_stock_count,
        SUM(i.quantity * i.unit_price)                                     AS stock_value
      FROM companies c
      LEFT JOIN items i ON i.company_id = c.id
      GROUP BY c.id
      ORDER BY c.name
    `).all();
    res.json(companies);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

// GET /api/companies/:id
router.get('/:id', (req, res) => {
  const db = getDB();
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
  if (!company) return res.status(404).json({ error: 'Company not found' });
  res.json(company);
});

// POST /api/companies
router.post('/', (req, res) => {
  const { name, email, phone, address } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Company name is required' });

  const db = getDB();
  try {
    const result = db.prepare(
      'INSERT INTO companies (name, email, phone, address) VALUES (?, ?, ?, ?)'
    ).run(name.trim(), email || null, phone || null, address || null);
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(company);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A company with that name already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to create company' });
  }
});

// PUT /api/companies/:id
router.put('/:id', (req, res) => {
  const { name, email, phone, address } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Company name is required' });

  const db = getDB();
  try {
    const info = db.prepare(
      'UPDATE companies SET name=?, email=?, phone=?, address=? WHERE id=?'
    ).run(name.trim(), email || null, phone || null, address || null, req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Company not found' });
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
    res.json(company);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A company with that name already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to update company' });
  }
});

// DELETE /api/companies/:id
router.delete('/:id', (req, res) => {
  const db = getDB();
  const info = db.prepare('DELETE FROM companies WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Company not found' });
  res.json({ message: 'Company deleted successfully' });
});

module.exports = router;
