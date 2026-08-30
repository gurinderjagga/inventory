import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { api, isAuthError } from '../api.js';
import { listContainer, listItem, hoverLift } from '../lib/motion.js';
import { formatCurrency, formatCurrencyShort } from '../lib/format.js';
import { useToast } from '../contexts/ToastContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import Modal from '../components/Modal.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { IconAlert, IconBack, IconCheck, IconChevron, IconCompany, IconDelete, IconEdit, IconPlus, IconSearch, IconStock, IconSuccess, IconWarning, ICON_MD } from '../lib/icons.jsx';

const UNITS = ['pcs', 'boxes', 'reams', 'kg', 'liters', 'sets', 'packs', 'rolls', 'pairs'];
const EMPTY_FORM = { name: '', sku: '', unit: 'pcs', quantity: '', unit_price: '', low_stock_threshold: '10' };

export default function Stock() {
  const { toast }               = useToast();
  const { isAdmin }            = useAuth();
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

  /* ── Load items for selected company ──────────────── */
  // Declared before loadCompanies, which calls it when auto-selecting.
  const loadItems = useCallback(async (company) => {
    setLoadingItems(true);
    try {
      const data = await api.getItems(company.id);
      setItems(data);
    } catch (e) { if (!isAuthError(e)) toast.error(e.message); }
    finally { setLoadingItems(false); }
  }, [toast]);

  /* ── Load companies ────────────────────────────────── */
  const loadCompanies = useCallback(async () => {
    try {
      const data = await api.getCompanies();
      setCompanies(data);

      // A company admin belongs to exactly one company, and the API returns
      // only that one — asking them to choose from a list of one is pointless,
      // so go straight to their stock.
      if (!isAdmin && data.length === 1) {
        setSelected(data[0]);
        loadItems(data[0]);
      }
    } catch (e) { if (!isAuthError(e)) toast.error(e.message); }
    finally { setLoadingComp(false); }
  }, [toast, isAdmin, loadItems]);

  useEffect(() => { loadCompanies(); }, [loadCompanies]);

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
    const { id, name } = confirm;
    // Close first: an item that appears on an invoice cannot be deleted, and
    // the dialog lingering made that refusal look like a broken button.
    setConfirm(null);
    try {
      await api.deleteItem(id);
      toast.success(`"${name}" removed.`);
      loadItems(selected);
    } catch (e) {
      if (!isAuthError(e)) toast.error(e.message, 'Could not delete item');
    }
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
            <IconCompany size={ICON_MD} />
            <h3>No companies yet</h3>
            <p>Add companies from the Companies page first.</p>
          </div>
        ) : (
          <motion.div className="company-cards-grid" variants={listContainer} initial="initial" animate="animate">
            {companies.map(c => {
              const low = c.low_stock_count || 0;
              return (
                <motion.div key={c.id} className="company-card" onClick={() => selectCompany(c)} role="button" tabIndex={0}
                     variants={listItem} {...hoverLift}
                     onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && selectCompany(c)}>
                  <div className="company-card-icon"><IconCompany size={ICON_MD} /></div>
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
                      <span className="val" style={{ color: 'var(--success)', fontSize: 14 }}>{formatCurrencyShort(c.stock_value)}</span>
                      <span className="lbl">Value</span>
                    </div>
                  </div>
                  {low > 0 && <div style={{ marginTop: 12 }}><span className="badge badge-warning"><IconWarning size={ICON_MD} /> {low} items low</span></div>}
                </motion.div>
              );
            })}
          </motion.div>
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
      {/* Breadcrumb — only meaningful when there is a company list to go back to */}
      {isAdmin && (
        <div className="breadcrumb">
          <button onClick={goBack} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, padding: 0 }}>
            Stock
          </button>
          <IconChevron size={ICON_MD} style={{ fontSize: 10 }} />
          <span className="current">{selected.name}</span>
        </div>
      )}

      {/* Page header with actions */}
      <div className="page-header">
        <div className="page-header-text">
          <h2>{selected.name}</h2>
          <p>{items.length} item{items.length !== 1 ? 's' : ''} in inventory</p>
        </div>
        <div className="flex gap-2 items-center" style={{ flexWrap: 'wrap' }}>
          {isAdmin && (
            <button className="btn btn-secondary" onClick={goBack}>
              <IconBack size={ICON_MD} /> All Companies
            </button>
          )}
          <div className="search-wrap">
            <IconSearch size={ICON_MD} />
            <input placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={openAdd}>
            <IconPlus size={ICON_MD} /> Add Item
          </button>
        </div>
      </div>

      {loadingItems ? (
        <div className="loading-page"><div className="spinner" /></div>
      ) : filteredItems.length === 0 ? (
        <div className="empty-state">
          <IconStock size={ICON_MD} />
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
            <motion.tbody variants={listContainer} initial="initial" animate="animate">
              {filteredItems.map(item => {
                const isLow  = item.quantity <= item.low_stock_threshold;
                const pct    = item.low_stock_threshold > 0
                  ? Math.min(100, (item.quantity / (item.low_stock_threshold * 3)) * 100) : 100;
                const barClr = isLow ? 'var(--warning)' : item.quantity > item.low_stock_threshold * 2 ? 'var(--success)' : 'var(--info)';
                return (
                  <motion.tr key={item.id} variants={listItem}>
                    <td style={{ fontWeight: 600 }}>{item.name}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 500, color: 'var(--accent)', whiteSpace: 'nowrap' }}>{item.sku || '—'}</td>
                    <td>{item.unit}</td>
                    <td>
                      <div className="stock-bar-wrap">
                        <span style={{ fontWeight: 600, minWidth: 32 }}>{item.quantity}</span>
                        <div className="stock-bar">
                          <motion.div
                            className="stock-bar-fill"
                            style={{ background: barClr }}
                            initial={{ width: 0 }}
                            animate={{ width: `${pct}%` }}
                            transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
                          />
                        </div>
                      </div>
                    </td>
                    <td>{formatCurrency(item.unit_price)}</td>
                    <td style={{ fontWeight: 600, color: 'var(--success)' }}>{formatCurrency(item.quantity * item.unit_price)}</td>
                    <td>
                      {isLow
                        ? <span className="badge badge-warning"><IconWarning size={ICON_MD} /> Low</span>
                        : <span className="badge badge-success"><IconSuccess size={ICON_MD} /> OK</span>}
                    </td>
                    <td>
                      <div className="td-actions">
                        <button className="btn btn-secondary btn-sm" onClick={() => openEdit(item)}><IconEdit size={ICON_MD} /></button>
                        <button className="btn btn-danger btn-sm" onClick={() => setConfirm({ id: item.id, name: item.name })}><IconDelete size={ICON_MD} /></button>
                      </div>
                    </td>
                  </motion.tr>
                );
              })}
            </motion.tbody>
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
              {saving ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Saving…</> : <><IconCheck size={ICON_MD} /> {modal?.mode === 'add' ? 'Add Item' : 'Save Changes'}</>}
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
          <div className="form-group"><label>Unit Price (₹) <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input type="number" min="0" step="0.01" placeholder="0.00" {...field('unit_price')} />
          </div>
        </div>
        <div className="form-group"><label>Low Stock Threshold</label>
          <input type="number" min="0" placeholder="10" {...field('low_stock_threshold')} />
          <small style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4, display: 'block' }}>Alert when quantity falls at or below this value</small>
        </div>
        {formErr && <div className="login-error"><IconAlert size={ICON_MD} /><span>{formErr}</span></div>}
      </Modal>

      <ConfirmDialog isOpen={!!confirm} title="Delete Item"
        message={<>Remove <strong>{confirm?.name}</strong> from {selected.name}&rsquo;s inventory? This cannot be undone.</>}
        confirmText="Delete" danger
        onConfirm={handleDelete} onCancel={() => setConfirm(null)} />
    </div>
  );
}
