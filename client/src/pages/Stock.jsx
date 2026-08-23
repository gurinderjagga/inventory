import { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import { useToast } from '../contexts/ToastContext.jsx';
import Modal from '../components/Modal.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';

const UNITS = ['pcs', 'boxes', 'reams', 'kg', 'liters', 'sets', 'packs', 'rolls', 'pairs'];
const EMPTY_FORM = { name: '', sku: '', unit: 'pcs', quantity: '', unit_price: '', low_stock_threshold: '10' };

export default function Stock() {
  const { toast }               = useToast();
  const [companies, setCompanies] = useState([]);
  const [selected, setSelected]   = useState(null);   // selected company
  const [items, setItems]         = useState([]);
  const [search, setSearch]       = useState('');
  const [loadingComp, setLoadingComp] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [modal, setModal]         = useState(null);
  const [form, setForm]           = useState(EMPTY_FORM);
  const [formErr, setFormErr]     = useState('');
  const [saving, setSaving]       = useState(false);
  const [confirm, setConfirm]     = useState(null);

  /* ── Load companies ────────────────────────────────── */
  const loadCompanies = useCallback(async () => {
    try {
      const data = await api.getCompanies();
      setCompanies(data);
    } catch (e) { toast.error(e.message); }
    finally { setLoadingComp(false); }
  }, [toast]);

  useEffect(() => { loadCompanies(); }, [loadCompanies]);

  /* ── Load items for selected company ──────────────── */
  const loadItems = useCallback(async (company) => {
    setLoadingItems(true);
    try {
      const data = await api.getItems(company.id);
      setItems(data);
    } catch (e) { toast.error(e.message); }
    finally { setLoadingItems(false); }
  }, [toast]);

  const selectCompany = (company) => {
    setSelected(company);
    setSearch('');
    loadItems(company);
  };

  const goBack = async () => {
    setSelected(null);
    setItems([]);
    setSearch('');
    await loadCompanies();
  };

  /* ── Item modal ────────────────────────────────────── */
  const openAdd = () => {
    setForm(EMPTY_FORM);
    setFormErr('');
    setModal({ mode: 'add', data: null });
  };

  const openEdit = (item) => {
    setForm({
      name: item.name, sku: item.sku || '', unit: item.unit,
      quantity: String(item.quantity), unit_price: String(item.unit_price),
      low_stock_threshold: String(item.low_stock_threshold),
    });
    setFormErr('');
    setModal({ mode: 'edit', data: item });
  };

  const closeModal = () => { setModal(null); setSaving(false); };

  const handleSave = async () => {
    if (!form.name.trim()) { setFormErr('Item name is required.'); return; }
    const qty   = parseFloat(form.quantity);
    const price = parseFloat(form.unit_price);
    if (isNaN(qty) || qty < 0) { setFormErr('Quantity must be ≥ 0.'); return; }
    if (isNaN(price) || price < 0) { setFormErr('Unit price must be ≥ 0.'); return; }

    setSaving(true); setFormErr('');
    const payload = {
      name: form.name.trim(), sku: form.sku.trim() || null, unit: form.unit,
      quantity: qty, unit_price: price,
      low_stock_threshold: parseFloat(form.low_stock_threshold) || 10,
    };
    try {
      if (modal.mode === 'add') {
        await api.createItem({ ...payload, company_id: selected.id });
        toast.success('Item added.');
      } else {
        await api.updateItem(modal.data.id, payload);
        toast.success('Item updated.');
      }
      closeModal();
      loadItems(selected);
    } catch (e) { setFormErr(e.message); setSaving(false); }
  };

  const handleDelete = async () => {
    if (!confirm) return;
    try {
      await api.deleteItem(confirm.id);
      toast.success(`"${confirm.name}" removed.`);
      setConfirm(null);
      loadItems(selected);
    } catch (e) { toast.error(e.message); }
  };

  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm(f => ({ ...f, [key]: e.target.value })),
  });

  /* ── Company grid ─────────────────────────────────── */
  if (!selected) {
    if (loadingComp) return <div className="loading-page"><div className="spinner" /><span>Loading…</span></div>;
    return (
      <div className="page-enter">
        <div className="page-header">
          <div className="page-header-text">
            <h2>Select a Company</h2>
            <p>Click a company to view and manage its stock inventory</p>
          </div>
        </div>
        {companies.length === 0 ? (
          <div className="empty-state">
            <i className="bi bi-building" />
            <h3>No companies yet</h3>
            <p>Add companies from the Companies page first.</p>
          </div>
        ) : (
          <div className="company-cards-grid">
            {companies.map(c => {
              const low = c.low_stock_count || 0;
              return (
                <div key={c.id} className="company-card" onClick={() => selectCompany(c)} role="button" tabIndex={0}
                     onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && selectCompany(c)}>
                  <div className="company-card-icon"><i className="bi bi-building-fill" /></div>
                  <h3>{c.name}</h3>
                  <div className="company-card-meta">{c.email || ''}{c.phone ? ' · ' + c.phone : ''}</div>
                  <div className="company-card-stats">
                    <div className="company-card-stat">
                      <span className="val" style={{ color: 'var(--text-accent)' }}>{c.item_count || 0}</span>
                      <span className="lbl">Items</span>
                    </div>
                    <div className="company-card-stat">
                      <span className="val" style={{ color: low > 0 ? 'var(--warning)' : 'var(--success)' }}>{low}</span>
                      <span className="lbl">Low Stock</span>
                    </div>
                    <div className="company-card-stat">
                      <span className="val" style={{ color: 'var(--success)', fontSize: 14 }}>${Number(c.stock_value || 0).toFixed(0)}</span>
                      <span className="lbl">Value</span>
                    </div>
                  </div>
                  {low > 0 && <div style={{ marginTop: 12 }}><span className="badge badge-warning"><i className="bi bi-exclamation-triangle" /> {low} items low</span></div>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  /* ── Items table ──────────────────────────────────── */
  const filteredItems = items.filter(i =>
    i.name.toLowerCase().includes(search.toLowerCase()) ||
    (i.sku || '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="page-enter">
      {/* Breadcrumb */}
      <div className="breadcrumb">
        <button onClick={goBack} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, padding: 0 }}>
          Stock
        </button>
        <i className="bi bi-chevron-right" style={{ fontSize: 10 }} />
        <span className="current">{selected.name}</span>
      </div>

      {/* Page header with actions */}
      <div className="page-header">
        <div className="page-header-text">
          <h2>{selected.name}</h2>
          <p>{items.length} item{items.length !== 1 ? 's' : ''} in inventory</p>
        </div>
        <div className="flex gap-2 items-center" style={{ flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={goBack}>
            <i className="bi bi-arrow-left" /> All Companies
          </button>
          <div className="search-wrap">
            <i className="bi bi-search" />
            <input placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={openAdd}>
            <i className="bi bi-plus-lg" /> Add Item
          </button>
        </div>
      </div>

      {loadingItems ? (
        <div className="loading-page"><div className="spinner" /></div>
      ) : filteredItems.length === 0 ? (
        <div className="empty-state">
          <i className="bi bi-box-seam" />
          <h3>No items found</h3>
          <p>Add your first stock item using the button above.</p>
        </div>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Item Name</th><th>SKU</th><th>Unit</th>
                <th>Stock Level</th><th>Unit Price</th><th>Stock Value</th>
                <th>Status</th><th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map(item => {
                const isLow  = item.quantity <= item.low_stock_threshold;
                const pct    = item.low_stock_threshold > 0
                  ? Math.min(100, (item.quantity / (item.low_stock_threshold * 3)) * 100) : 100;
                const barClr = isLow ? 'var(--warning)' : item.quantity > item.low_stock_threshold * 2 ? 'var(--success)' : 'var(--info)';
                return (
                  <tr key={item.id}>
                    <td style={{ fontWeight: 600 }}>{item.name}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-accent)' }}>{item.sku || '—'}</td>
                    <td>{item.unit}</td>
                    <td>
                      <div className="stock-bar-wrap">
                        <span style={{ fontWeight: 600, minWidth: 32 }}>{item.quantity}</span>
                        <div className="stock-bar">
                          <div className="stock-bar-fill" style={{ width: `${pct}%`, background: barClr }} />
                        </div>
                      </div>
                    </td>
                    <td>${parseFloat(item.unit_price).toFixed(2)}</td>
                    <td style={{ fontWeight: 600, color: 'var(--success)' }}>${(item.quantity * item.unit_price).toFixed(2)}</td>
                    <td>
                      {isLow
                        ? <span className="badge badge-warning"><i className="bi bi-exclamation-triangle" /> Low</span>
                        : <span className="badge badge-success"><i className="bi bi-check-circle" /> OK</span>}
                    </td>
                    <td>
                      <div className="td-actions">
                        <button className="btn btn-secondary btn-sm" onClick={() => openEdit(item)}><i className="bi bi-pencil" /></button>
                        <button className="btn btn-danger btn-sm" onClick={() => setConfirm({ id: item.id, name: item.name })}><i className="bi bi-trash3" /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Item modal */}
      <Modal isOpen={!!modal} onClose={closeModal}
        title={modal?.mode === 'add' ? 'Add Stock Item' : `Edit: ${modal?.data?.name}`}
        footer={
          <>
            <button className="btn btn-secondary" onClick={closeModal}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Saving…</> : <><i className="bi bi-check-lg" /> {modal?.mode === 'add' ? 'Add Item' : 'Save Changes'}</>}
            </button>
          </>
        }
      >
        <div className="form-group"><label>Item Name <span style={{ color: 'var(--danger)' }}>*</span></label>
          <input type="text" placeholder="e.g. HDMI Cable" {...field('name')} autoFocus />
        </div>
        <div className="form-row">
          <div className="form-group"><label>SKU / Code</label>
            <input type="text" placeholder="e.g. TC-001" {...field('sku')} />
          </div>
          <div className="form-group"><label>Unit</label>
            <select {...field('unit')}>{UNITS.map(u => <option key={u} value={u}>{u}</option>)}</select>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group"><label>Quantity <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input type="number" min="0" step="0.01" placeholder="0" {...field('quantity')} />
          </div>
          <div className="form-group"><label>Unit Price ($) <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input type="number" min="0" step="0.01" placeholder="0.00" {...field('unit_price')} />
          </div>
        </div>
        <div className="form-group"><label>Low Stock Threshold</label>
          <input type="number" min="0" placeholder="10" {...field('low_stock_threshold')} />
          <small style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4, display: 'block' }}>Alert when quantity falls at or below this value</small>
        </div>
        {formErr && <div className="login-error"><i className="bi bi-exclamation-circle" /><span>{formErr}</span></div>}
      </Modal>

      <ConfirmDialog isOpen={!!confirm} title="Delete Item"
        message={`Remove <strong>${confirm?.name}</strong> from ${selected.name}'s inventory? This cannot be undone.`}
        confirmText="Delete" danger
        onConfirm={handleDelete} onCancel={() => setConfirm(null)} />
    </div>
  );
}
