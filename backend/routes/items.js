const express = require('express');
const { getDB } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// GET /api/items/company/:companyId  — items scoped to a company
router.get('/company/:companyId', (req, res) => {
  const db = getDB();
  const items = db.prepare(
    'SELECT * FROM items WHERE company_id = ? ORDER BY name ASC'
  ).all(req.params.companyId);
  res.json(items);
});

// GET /api/items/:id
router.get('/:id', (req, res) => {
  const db = getDB();
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  res.json(item);
});

// POST /api/items
router.post('/', (req, res) => {
  const { company_id, name, sku, unit, quantity, unit_price, low_stock_threshold } = req.body;
  if (!company_id) return res.status(400).json({ error: 'company_id is required' });
  if (!name?.trim()) return res.status(400).json({ error: 'Item name is required' });
  if (quantity < 0) return res.status(400).json({ error: 'Quantity cannot be negative' });
  if (unit_price < 0) return res.status(400).json({ error: 'Unit price cannot be negative' });

  const db = getDB();
  try {
    const result = db.prepare(`
      INSERT INTO items (company_id, name, sku, unit, quantity, unit_price, low_stock_threshold)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      company_id,
      name.trim(),
      sku?.trim() || null,
      unit?.trim() || 'pcs',
      parseFloat(quantity) || 0,
      parseFloat(unit_price) || 0,
      parseFloat(low_stock_threshold) || 10
    );
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create item' });
  }
});

// PUT /api/items/:id
router.put('/:id', (req, res) => {
  const { name, sku, unit, quantity, unit_price, low_stock_threshold } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Item name is required' });

  const db = getDB();
  try {
    const info = db.prepare(`
      UPDATE items
      SET name=?, sku=?, unit=?, quantity=?, unit_price=?, low_stock_threshold=?
      WHERE id=?
    `).run(
      name.trim(),
      sku?.trim() || null,
      unit?.trim() || 'pcs',
      parseFloat(quantity) || 0,
      parseFloat(unit_price) || 0,
      parseFloat(low_stock_threshold) || 10,
      req.params.id
    );
    if (info.changes === 0) return res.status(404).json({ error: 'Item not found' });
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
    res.json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// DELETE /api/items/:id
router.delete('/:id', (req, res) => {
  const db = getDB();
  const info = db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Item not found' });
  res.json({ message: 'Item deleted successfully' });
});

module.exports = router;
