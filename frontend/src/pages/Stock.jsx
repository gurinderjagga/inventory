import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api, isAuthError } from '../api.js';
import { listContainer, listItem, hoverLift } from '../lib/motion.js';
import { formatCurrency, formatCurrencyShort } from '../lib/format.js';
import { useToast } from '../contexts/ToastContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import Modal from '../components/Modal.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Pagination, { usePagination } from '../components/Pagination.jsx';
import { useTableSort, SortableTh } from '../lib/useTableSort.jsx';
import { IconAlert, IconBack, IconCheck, IconChevron, IconCompany, IconDelete, IconEdit, IconPlus, IconSearch, IconStock, IconSuccess, IconWarning, ICON_MD } from '../lib/icons.jsx';

const UNITS = ['pcs', 'boxes', 'reams', 'kg', 'liters', 'sets', 'packs', 'rolls', 'pairs'];

/**
 * Units counted in whole things. A shelf cannot hold 2.5 pieces, and letting
 * the field accept it produced quantities no one could pick or ship.
 */
const DISCRETE_UNITS = new Set(['pcs', 'boxes', 'reams', 'sets', 'packs', 'rolls', 'pairs']);

const SORT_COLUMNS = {
  name:        r => r.name,
  sku:         r => r.sku || '',
  unit:        r => r.unit,
  quantity:    r => Number(r.quantity),
  unit_price:  r => Number(r.unit_price),
  stock_value: r => Number(r.quantity) * Number(r.unit_price),
  status:      r => (Number(r.quantity) <= Number(r.low_stock_threshold) ? 0 : 1),
};
const EMPTY_FORM = { name: '', sku: '', unit: 'pcs', quantity: '', unit_price: '', low_stock_threshold: '10' };

export default function Stock() {
  const { toast }                 = useToast();
  const [companies, setCompanies] = useState([]);
  const [items, setItems]         = useState([]);
  const [refreshKey, setRefreshKey] = useState(0);    // bumped to refetch items
  const [search, setSearch]       = useState('');
  const [loadingComp, setLoadingComp] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [modal, setModal]         = useState(null);
  const [form, setForm]           = useState(EMPTY_FORM);
  const [formErr, setFormErr]     = useState('');
  const [saving, setSaving]       = useState(false);
  const [confirm, setConfirm]     = useState(null);
  const [deleting, setDeleting]   = useState(false);
  const [pristine, setPristine]   = useState('');

  // Which company's stock is on screen lives in the URL, not in useState.
  // Held only in state, the view could not be bookmarked or shared, a refresh
  // dumped an admin back to the picker, and Back left the page entirely
  // instead of returning to the company list.
  const [params, setParams] = useSearchParams();
  const companyParam        = params.get('company');

  const dirty      = !!modal && JSON.stringify(form) !== pristine;
  const isDiscrete = DISCRETE_UNITS.has(form.unit);

  /* ── Load companies ────────────────────────────────── */
  const loadCompanies = useCallback(async () => {
    try {
      const data = await api.getCompanies();
      setCompanies(data);
    } catch (e) { if (!isAuthError(e)) toast.error(e.message); }
    finally { setLoadingComp(false); }
  }, [toast]);

  useEffect(() => { loadCompanies(); }, [loadCompanies]);

  // The company on screen is whichever one the URL names.
  const selected = companies.find(c => String(c.id) === companyParam) || null;

  // A link to a company that no longer exists falls back to the picker instead
  // of showing an empty, nameless stock page.
  useEffect(() => {
    if (loadingComp || !companyParam || selected) return;
    toast.warning('That company is no longer available.');
    setParams({}, { replace: true });
  }, [loadingComp, companyParam, selected, setParams, toast]);

  /* ── Load items for the selected company ───────────── */
  const selectedId = selected?.id;

  useEffect(() => {
    if (!selectedId) { setItems([]); return; }
    let cancelled = false;
    setLoadingItems(true);
    api.getItems(selectedId)
      .then(data => { if (!cancelled) setItems(data); })
      .catch(e => { if (!cancelled && !isAuthError(e)) toast.error(e.message); })
      .finally(() => { if (!cancelled) setLoadingItems(false); });
    // Ignore a response that arrives after the user has moved on.
    return () => { cancelled = true; };
  }, [selectedId, refreshKey, toast]);

  const selectCompany = (company) => {
    setSearch('');
    setParams({ company: String(company.id) });   // pushed, so Back returns here
  };

  const goBack = () => {
    setSearch('');
    setParams({});
    loadCompanies();   // pick up stock-value changes made while inside
  };

  /* ── Item modal ────────────────────────────────────── */
  const openAdd = () => {
    setForm(EMPTY_FORM);
    setPristine(JSON.stringify(EMPTY_FORM));
    setFormErr('');
    setModal({ mode: 'add', data: null });
  };

  const openEdit = (item) => {
    const next = {
      name: item.name, sku: item.sku || '', unit: item.unit,
      quantity: String(item.quantity), unit_price: String(item.unit_price),
      low_stock_threshold: String(item.low_stock_threshold),
    };
    setForm(next);
    setPristine(JSON.stringify(next));
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
    if (DISCRETE_UNITS.has(form.unit) && !Number.isInteger(qty)) {
      setFormErr(`Quantity must be a whole number when the unit is ${form.unit}.`);
      return;
    }

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
      setRefreshKey(k => k + 1);
    } catch (e) { setFormErr(e.message); setSaving(false); }
  };

  const handleDelete = async () => {
    if (!confirm || deleting) return;
    const { id, name } = confirm;
    // Keep the dialog up, showing progress, until the request settles. An item
    // that appears on an invoice cannot be deleted, and that refusal now
    // arrives in a toast that stays put.
    setDeleting(true);
    try {
      await api.deleteItem(id);
      toast.success(`"${name}" removed.`);
      setRefreshKey(k => k + 1);
    } catch (e) {
      if (!isAuthError(e)) toast.error(e.message, 'Could not delete item');
    } finally {
      setDeleting(false);
      setConfirm(null);
    }
  };

  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm(f => ({ ...f, [key]: e.target.value })),
  });

  /* ── Filter, sort, page ───────────────────────────────
     Computed before the company-grid early return below: hooks cannot sit
     behind a conditional. Harmless when no company is selected — `items` is
     empty and nothing renders from it. */
  const filteredItems = items.filter(i =>
    i.name.toLowerCase().includes(search.toLowerCase()) ||
    (i.sku || '').toLowerCase().includes(search.toLowerCase())
  );
  const { sorted, sort, toggle } = useTableSort(filteredItems, SORT_COLUMNS);
  const pager = usePagination(sorted);

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
            <IconCompany />
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
                     // preventDefault, or Space both activates the card and
                     // scrolls the page underneath it.
                     onKeyDown={e => {
                       if (e.key !== 'Enter' && e.key !== ' ') return;
                       e.preventDefault();
                       selectCompany(c);
                     }}>
                  <div className="company-card-icon"><IconCompany size={ICON_MD} /></div>
                  <h3>{c.name}</h3>
                  <div className="company-card-meta">{c.email || ''}{c.phone ? ' · ' + c.phone : ''}</div>
                  <div className="company-card-stats">
                    <div className="company-card-stat">
                      <span className="val">{c.item_count || 0}</span>
                      <span className="lbl">Items</span>
                    </div>
                    <div className="company-card-stat">
                      <span className="val" style={{ color: low > 0 ? 'var(--warning)' : 'var(--success)' }}>{low}</span>
                      <span className="lbl">Low Stock</span>
                    </div>
                    <div className="company-card-stat">
                      <span className="val" style={{ fontSize: 13 }}>{formatCurrencyShort(c.stock_value)}</span>
                      <span className="lbl">Value</span>
                    </div>
                  </div>
                  {low > 0 && <div style={{ marginTop: 10 }}><span className="badge badge-warning">{low} low</span></div>}
                </motion.div>
              );
            })}
          </motion.div>
        )}
      </div>
    );
  }

  /* ── Items table ──────────────────────────────────── */
  return (
    <div className="page-enter">
      <div className="breadcrumb">
        <button type="button" onClick={goBack} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, padding: 0 }}>
          Stock
        </button>
        <IconChevron size={ICON_MD} style={{ fontSize: 10 }} />
        <span className="current">{selected.name}</span>
      </div>

      {/* Page header with actions */}
      <div className="page-header">
        <div className="page-header-text">
          <h2>{selected.name}</h2>
          <p>
            {search
              ? `${filteredItems.length} of ${items.length} item${items.length !== 1 ? 's' : ''} shown`
              : `${items.length} item${items.length !== 1 ? 's' : ''} in inventory`}
          </p>
        </div>
        <div className="flex gap-2 items-center" style={{ flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={goBack}>
            <IconBack size={ICON_MD} /> All Companies
          </button>
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
        <EmptyState
          Icon={IconStock}
          query={search}
          onClear={() => setSearch('')}
          noun="items"
          title="No items yet"
          hint="Add your first stock item using the button above."
        />
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <SortableTh sortKey="name"        sort={sort} onToggle={toggle}>Item Name</SortableTh>
                <SortableTh sortKey="sku"         sort={sort} onToggle={toggle}>SKU</SortableTh>
                <SortableTh sortKey="unit"        sort={sort} onToggle={toggle}>Unit</SortableTh>
                <SortableTh sortKey="quantity"    sort={sort} onToggle={toggle} align="num">On Hand</SortableTh>
                <SortableTh sortKey="unit_price"  sort={sort} onToggle={toggle} align="num">Unit Price</SortableTh>
                <SortableTh sortKey="stock_value" sort={sort} onToggle={toggle} align="num">Stock Value</SortableTh>
                <SortableTh sortKey="status"      sort={sort} onToggle={toggle}>Status</SortableTh>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <motion.tbody variants={listContainer} initial="initial" animate="animate">
              {pager.visible.map(item => {
                const isLow  = item.quantity <= item.low_stock_threshold;
                // With no threshold set there is nothing to measure against,
                // so the bar tracks "is there any stock at all" rather than
                // showing a reassuring full bar for an empty shelf.
                const pct    = item.low_stock_threshold > 0
                  ? Math.min(100, (item.quantity / (item.low_stock_threshold * 3)) * 100)
                  : item.quantity > 0 ? 100 : 0;
                const barClr = isLow ? 'var(--warning)' : item.quantity > item.low_stock_threshold * 2 ? 'var(--success)' : 'var(--info)';
                return (
                  <motion.tr key={item.id} variants={listItem}>
                    <td className="cell-primary">{item.name}</td>
                    <td className="code">{item.sku || '—'}</td>
                    <td className="cell-muted">{item.unit}</td>
                    <td className="num">
                      <div className="stock-bar-wrap">
                        <span className="num num-strong">{item.quantity}</span>
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
                    <td className="num">{formatCurrency(item.unit_price)}</td>
                    <td className="num num-strong">{formatCurrency(item.quantity * item.unit_price)}</td>
                    <td>
                      {isLow
                        ? <span className="badge badge-warning">Low</span>
                        : <span className="badge badge-success">In stock</span>}
                    </td>
                    <td>
                      <div className="td-actions">
                        <button className="btn btn-secondary btn-sm" onClick={() => openEdit(item)}
                                title={`Edit ${item.name}`} aria-label={`Edit ${item.name}`}>
                          <IconEdit size={ICON_MD} />
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => setConfirm({ id: item.id, name: item.name })}
                                title={`Delete ${item.name}`} aria-label={`Delete ${item.name}`}>
                          <IconDelete size={ICON_MD} />
                        </button>
                      </div>
                    </td>
                  </motion.tr>
                );
              })}
            </motion.tbody>
          </table>
        </div>
      )}
      <Pagination {...pager} noun="items" />

      {/* Item modal */}
      <Modal isOpen={!!modal} onClose={closeModal}
        title={modal?.mode === 'add' ? 'Add Stock Item' : `Edit: ${modal?.data?.name}`}
        onSubmit={handleSave}
        dirty={dirty}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={closeModal}>Cancel</button>
            <button className="btn btn-primary" disabled={saving}>
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
            {/* Whole numbers for units you count, decimals for kg and litres. */}
            <input type="number" min="0" step={isDiscrete ? '1' : '0.01'} placeholder="0" {...field('quantity')} />
            {isDiscrete && (
              <small style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4, display: 'block' }}>
                Whole {form.unit} only.
              </small>
            )}
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
        confirmText="Delete" busyText="Deleting…" danger busy={deleting}
        onConfirm={handleDelete} onCancel={() => setConfirm(null)} />
    </div>
  );
}
