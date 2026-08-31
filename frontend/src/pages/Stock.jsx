import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api, isAuthError } from '../api.js';
import { cached, invalidate, CACHE_COMPANIES } from '../lib/cache.js';
import { listContainer, listItem, hoverLift } from '../lib/motion.js';
import { formatCurrency, formatCurrencyShort } from '../lib/format.js';
import { useToast } from '../contexts/ToastContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import Modal from '../components/Modal.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Pagination, { usePagination } from '../components/Pagination.jsx';
import { useTableSort, SortableTh } from '../lib/useTableSort.jsx';
import { IconAlert, IconBack, IconCheck, IconChevron, IconCompany, IconEdit, IconSearch, IconStock, IconAdjust, IconHistory, ICON_MD } from '../lib/icons.jsx';

function TableSkeleton({ rows = 6 }) {
  return (
    <div className="skeleton-table" style={{ marginTop: 16 }}>
      <div className="skeleton-thead">
        {[1, 2, 3, 4, 5, 6].map(i => <div key={i} className="skeleton-bar" />)}
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row" style={{ opacity: 1 - i * 0.1 }}>
          <div className="skeleton-bar" />
          <div className="skeleton-bar" />
          <div className="skeleton-bar" />
          <div className="skeleton-bar" />
          <div className="skeleton-bar" />
        </div>
      ))}
    </div>
  );
}


/** A human label for each stock_movements.reason value. */
const MOVEMENT_LABELS = {
  initial_stock:     'Initial stock',
  invoice_finalize:  'Invoice finalized',
  invoice_reversal:  'Invoice reversed',
  goods_received:    'Goods received',
  manual_adjustment: 'Manual adjustment',
};

const UNITS = ['pcs', 'boxes', 'reams', 'kg', 'liters', 'sets', 'packs', 'rolls', 'pairs'];

// GST's Unit Quantity Code — the unit returns are filed in. A small, common
// subset rather than the full CBIC list; PCS/NOS covers most goods here.
const UQC_CODES = ['PCS', 'NOS', 'KGS', 'LTR', 'MTR', 'BOX', 'SET', 'PAC', 'DOZ', 'OTH'];

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
const EMPTY_FORM = {
  name: '', sku: '', unit: 'pcs', quantity: '', unit_price: '', low_stock_threshold: '10',
  hsn_sac_code: '', is_service: false, gst_rate: '', uqc: '', cost_price: '',
};

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
  const [adjust, setAdjust]       = useState(null);   // null | { item, quantity, reason, saving, err }
  const [history, setHistory]     = useState(null);   // null | { item, loading, movements }

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
      const data = await cached(CACHE_COMPANIES, () => api.getCompanies());
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
  const openEdit = (item) => {
    const next = {
      name: item.name, sku: item.sku || '', unit: item.unit,
      quantity: String(item.quantity), unit_price: String(item.unit_price),
      low_stock_threshold: String(item.low_stock_threshold),
      hsn_sac_code: item.hsn_sac_code || '', is_service: !!item.is_service,
      gst_rate: item.gst_rate != null ? String(item.gst_rate) : '',
      uqc: item.uqc || '', cost_price: item.cost_price != null ? String(item.cost_price) : '',
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
    const gstRate   = form.gst_rate === '' ? 0 : parseFloat(form.gst_rate);
    const costPrice = form.cost_price === '' ? 0 : parseFloat(form.cost_price);
    if (isNaN(gstRate) || gstRate < 0) { setFormErr('GST rate must be ≥ 0.'); return; }
    if (isNaN(costPrice) || costPrice < 0) { setFormErr('Cost price must be ≥ 0.'); return; }

    setSaving(true); setFormErr('');
    const payload = {
      name: form.name.trim(), sku: form.sku.trim() || null, unit: form.unit,
      unit_price: price,
      low_stock_threshold: parseFloat(form.low_stock_threshold) || 10,
      hsn_sac_code: form.hsn_sac_code.trim() || null, is_service: form.is_service,
      gst_rate: gstRate, uqc: form.uqc || null, cost_price: costPrice,
    };
    try {
      if (modal.mode === 'add') {
        // Only creation carries a starting quantity — editing never touches
        // stock, see the Adjust Stock action below.
        await api.createItem({ ...payload, quantity: qty, company_id: selected.id });
        toast.success('Item added.');
      } else {
        await api.updateItem(modal.data.id, payload);
        toast.success('Item updated.');
      }
      closeModal();
      setRefreshKey(k => k + 1);
    } catch (e) { setFormErr(e.message); setSaving(false); }
  };

  /* ── Adjust stock ───────────────────────────────────── */
  const openAdjust = (item) => setAdjust({
    item, quantity: String(item.quantity), reason: '', saving: false, err: '',
  });
  const closeAdjust = () => setAdjust(null);

  const handleAdjust = async () => {
    const qty = parseFloat(adjust.quantity);
    if (isNaN(qty) || qty < 0) { setAdjust(a => ({ ...a, err: 'Quantity must be ≥ 0.' })); return; }
    if (!adjust.reason.trim()) { setAdjust(a => ({ ...a, err: 'A reason is required.' })); return; }

    setAdjust(a => ({ ...a, saving: true, err: '' }));
    try {
      await api.adjustItemQuantity(adjust.item.id, { quantity: qty, reason: adjust.reason.trim() });
      toast.success(`"${adjust.item.name}" adjusted.`);
      closeAdjust();
      setRefreshKey(k => k + 1);
    } catch (e) {
      setAdjust(a => ({ ...a, saving: false, err: e.message }));
    }
  };

  /* ── Movement history ─────────────────────────────────── */
  const openHistory = async (item) => {
    setHistory({ item, loading: true, movements: [] });
    try {
      const movements = await api.getItemMovements(item.id);
      setHistory(h => (h && h.item.id === item.id ? { ...h, loading: false, movements } : h));
    } catch (e) {
      setHistory(null);
      if (!isAuthError(e)) toast.error(e.message, 'Could not load history');
    }
  };
  const closeHistory = () => setHistory(null);

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

  const checkboxField = (key) => ({
    checked: form[key],
    onChange: (e) => setForm(f => ({ ...f, [key]: e.target.checked })),
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
    if (loadingComp) return (
      <div className="page-enter">
        <div className="page-header">
          <div className="page-header-text">
            <h2>Select a Company</h2>
            <p>Click a company to view and manage its stock inventory</p>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginTop: 8 }}>
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="skeleton-kpi" style={{ minHeight: 90 }}>
              <div className="skeleton-bar" style={{ height: 12, width: '70%' }} />
              <div className="skeleton-bar" style={{ height: 9,  width: '50%' }} />
              <div className="skeleton-bar" style={{ height: 9,  width: '40%' }} />
            </div>
          ))}
        </div>
      </div>
    );
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
        </div>
      </div>

      {loadingItems ? (
        <TableSkeleton />
      ) : filteredItems.length === 0 ? (
        <EmptyState
          Icon={IconStock}
          query={search}
          onClear={() => setSearch('')}
          noun="items"
          title="No items yet"
          hint="No items have been added to this company's inventory yet."
        />
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <SortableTh sortKey="sku"         sort={sort} onToggle={toggle}>Part Code</SortableTh>
                <SortableTh sortKey="name"        sort={sort} onToggle={toggle}>Item Name</SortableTh>
                <SortableTh sortKey="quantity"    sort={sort} onToggle={toggle} align="num">Quantity</SortableTh>
                <SortableTh sortKey="unit_price"  sort={sort} onToggle={toggle} align="num">Unit Price</SortableTh>
                <SortableTh sortKey="stock_value" sort={sort} onToggle={toggle} align="num">Stock Value</SortableTh>
                <SortableTh sortKey="status"      sort={sort} onToggle={toggle}>Status</SortableTh>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <motion.tbody variants={listContainer} initial="initial" animate="animate">
              {pager.visible.map(item => {
                // Coerced explicitly. These columns are NUMERIC, and a Postgres
                // driver hands NUMERIC back as a string unless told otherwise —
                // at which point `"10.000" <= "5.000"` compares lexicographically
                // and is TRUE, marking a well-stocked item as low. The API
                // currently sends numbers; this does not depend on it.
                const qty    = Number(item.quantity);
                const thresh = Number(item.low_stock_threshold);

                const isLow  = qty <= thresh;
                // With no threshold set there is nothing to measure against,
                // so the bar tracks "is there any stock at all" rather than
                // showing a reassuring full bar for an empty shelf.
                const pct    = thresh > 0
                  ? Math.min(100, (qty / (thresh * 3)) * 100)
                  : qty > 0 ? 100 : 0;
                const barClr = isLow ? 'var(--warning)' : qty > thresh * 2 ? 'var(--success)' : 'var(--info)';
                return (
                  <motion.tr key={item.id} variants={listItem}>
                    <td className="code">{item.sku || '—'}</td>
                    <td className="cell-primary">{item.name}</td>
                    <td className="num num-strong">{item.quantity}</td>
                    <td className="num">
                      {formatCurrency(item.unit_price)}
                      {Number(item.gst_rate) > 0 && (
                        <div className="cell-muted" style={{ fontSize: 11, marginTop: 2 }}>
                          {formatCurrency(item.unit_price * (1 + item.gst_rate / 100))} w/ {item.gst_rate}% GST
                        </div>
                      )}
                    </td>
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
                        <button className="btn btn-secondary btn-sm" onClick={() => openAdjust(item)}
                                title={`Adjust stock for ${item.name}`} aria-label={`Adjust stock for ${item.name}`}>
                          <IconAdjust size={ICON_MD} />
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={() => openHistory(item)}
                                title={`Movement history for ${item.name}`} aria-label={`Movement history for ${item.name}`}>
                          <IconHistory size={ICON_MD} />
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
        <div className="form-group"><label>Part Code</label>
          <input type="text" placeholder="e.g. TC-001" {...field('sku')} />
        </div>
        <div className="form-group"><label>Item Name <span style={{ color: 'var(--danger)' }}>*</span></label>
          <input type="text" placeholder="e.g. HDMI Cable" {...field('name')} autoFocus />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>{modal?.mode === 'add' ? <>Quantity <span style={{ color: 'var(--danger)' }}>*</span></> : 'Quantity'}</label>
            {/* Whole numbers for units you count, decimals for kg and litres.
                Read-only once the item exists: every later change has to be
                attributed and reasoned, via Adjust Stock, not a silent edit. */}
            <input type="number" min="0" step={isDiscrete ? '1' : '0.01'} placeholder="0"
                   disabled={modal?.mode === 'edit'} {...field('quantity')} />
            {modal?.mode === 'edit' ? (
              <small style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4, display: 'block' }}>
                Use the Adjust Stock action to change quantity.
              </small>
            ) : null}
          </div>
          <div className="form-group"><label>Unit Price (₹) <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input type="number" min="0" step="0.01" placeholder="0.00" {...field('unit_price')} />
          </div>
        </div>
        <div className="form-group"><label>Low Stock Threshold</label>
          <input type="number" min="0" placeholder="10" {...field('low_stock_threshold')} />
          <small style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4, display: 'block' }}>Alert when quantity falls at or below this value</small>
        </div>
        <div className="form-group">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" {...checkboxField('is_service')} />
            This is a service, not goods
          </label>
        </div>
        <div className="form-row">
          <div className="form-group"><label>{form.is_service ? 'SAC Code (optional)' : 'HSN Code (optional)'}</label>
            <input type="text" placeholder={form.is_service ? 'e.g. 998314' : 'e.g. 8471'} {...field('hsn_sac_code')} />
          </div>
          <div className="form-group"><label>UQC</label>
            <select {...field('uqc')}>
              <option value="">—</option>
              {UQC_CODES.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group"><label>GST Rate (%)</label>
            <input type="number" min="0" step="0.01" placeholder="0" {...field('gst_rate')} />
          </div>
          <div className="form-group"><label>Cost Price (₹)</label>
            <input type="number" min="0" step="0.01" placeholder="0.00" {...field('cost_price')} />
          </div>
        </div>
        {formErr && <div className="login-error"><IconAlert size={ICON_MD} /><span>{formErr}</span></div>}
      </Modal>


      {/* Adjust Stock modal */}
      {adjust && (
        <Modal isOpen={!!adjust} onClose={closeAdjust} title={`Adjust Stock: ${adjust.item.name}`}
          onSubmit={handleAdjust}
          footer={
            <>
              <button type="button" className="btn btn-secondary" onClick={closeAdjust}>Cancel</button>
              <button className="btn btn-primary" disabled={adjust.saving}>
                {adjust.saving
                  ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Saving…</>
                  : <><IconCheck size={ICON_MD} /> Adjust</>}
              </button>
            </>
          }
        >
          <div className="form-group">
            <label>New Quantity <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input type="number" min="0" step="0.01" autoFocus
                   value={adjust.quantity}
                   onChange={e => setAdjust(a => ({ ...a, quantity: e.target.value }))} />
            <small style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4, display: 'block' }}>
              Currently {adjust.item.quantity}
            </small>
          </div>
          <div className="form-group">
            <label>Reason <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input type="text" placeholder="e.g. Physical count correction, damaged stock…"
                   value={adjust.reason}
                   onChange={e => setAdjust(a => ({ ...a, reason: e.target.value }))} />
          </div>
          {adjust.err && <div className="login-error"><IconAlert size={ICON_MD} /><span>{adjust.err}</span></div>}
        </Modal>
      )}

      {/* Movement history modal */}
      {history && (
        <Modal isOpen={!!history} onClose={closeHistory} title={`History: ${history.item.name}`} size="modal-lg">
          {history.loading ? (
            <div className="loading-page" style={{ height: 120 }}><div className="spinner" /></div>
          ) : history.movements.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No stock movements recorded yet.</p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr><th>Date</th><th>Reason</th><th className="num">Change</th><th>Reference</th><th>By</th></tr>
                </thead>
                <tbody>
                  {history.movements.map(m => (
                    <tr key={m.id}>
                      <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>
                        {new Date(m.created_at).toLocaleString()}
                      </td>
                      <td>
                        {MOVEMENT_LABELS[m.reason] || m.reason}
                        {m.note && <div className="cell-muted" style={{ fontSize: 11 }}>{m.note}</div>}
                      </td>
                      <td className="num" style={{ color: Number(m.quantity_delta) < 0 ? 'var(--danger)' : 'var(--success)' }}>
                        {Number(m.quantity_delta) > 0 ? '+' : ''}{m.quantity_delta}
                      </td>
                      <td className="cell-muted">{m.invoice_no || '—'}</td>
                      <td className="cell-muted">{m.username || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
