import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { api, isAuthError } from '../api.js';
import { cached, CACHE_COMPANIES } from '../lib/cache.js';
import { useToast } from '../contexts/ToastContext.jsx';
import { listContainer, listItem } from '../lib/motion.js';
import { formatDate } from '../lib/format.js';
import {
  IconStockIn, IconStockOut, IconCompany, IconStock, IconRefresh,
  IconAlert, IconHistory, IconPlus, IconDelete, IconSearch, ICON_MD, ICON_LG, ICON_SM,
} from '../lib/icons.jsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

const EMPTY_LINE = () => ({ id: Math.random(), itemId: '', newItemName: '', partCode: '', quantity: '', price: '', gstRate: '', note: '' });

function reasonLabel(reason) {
  const map = {
    stock_in:          'Stock In',
    stock_out:         'Stock Out',
    initial_stock:     'Opening Balance',
    manual_adjustment: 'Manual Adjustment',
    invoice_finalize:  'Invoice (legacy)',
    invoice_reversal:  'Invoice Reversal (legacy)',
  };
  return map[reason] || reason;
}

function reasonClass(reason) {
  if (reason === 'stock_in'  || reason === 'initial_stock') return 'txn-in';
  if (reason === 'stock_out' || reason === 'invoice_finalize') return 'txn-out';
  return 'txn-neutral';
}

function deltaDisplay(delta) {
  const n = Number(delta);
  return n >= 0 ? `+${n}` : String(n);
}

// ── ItemCombobox ──────────────────────────────────────────────────────────────
// Searchable item picker. Shows existing items filtered by the typed text.
// If the text doesn't match any item exactly, offers "Add '[name]' as new item".

function ItemCombobox({ items, value, newItemName, onSelect, onNewItem, disabled, loading, lineIdx, allowCreateNew }) {
  const [query,   setQuery]   = useState('');
  const [open,    setOpen]    = useState(false);
  const [focused, setFocused] = useState(false);
  const wrapRef   = useRef(null);
  const inputRef  = useRef(null);

  // Display value: if an existing item is selected show its name, else show the new-item name
  const selectedItem = items.find(i => String(i.id) === String(value));
  const displayText  = open || focused ? query
    : selectedItem ? `${selectedItem.name}`
    : newItemName  ? `★ ${newItemName} (new)`
    : '';

  // When the dropdown opens, pre-fill the query with whatever is already shown
  const handleFocus = () => {
    setFocused(true);
    setOpen(true);
    setQuery(selectedItem
      ? `${selectedItem.name}`
      : newItemName || '');
  };

  const handleBlur = () => {
    // Small delay so a click on a dropdown option registers before we close
    setTimeout(() => {
      if (!wrapRef.current?.contains(document.activeElement)) {
        setOpen(false);
        setFocused(false);
        setQuery('');
      }
    }, 150);
  };

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
        setFocused(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = query.trim()
    ? items.filter(i =>
        i.name.toLowerCase().includes(query.toLowerCase()) ||
        (i.sku || '').toLowerCase().includes(query.toLowerCase())
      )
    : items;

  // Exact name match check (case-insensitive) — suppress "add new" if it already exists
  const exactMatch = items.some(i => i.name.trim().toLowerCase() === query.trim().toLowerCase());
  const showCreateOption = allowCreateNew && query.trim().length > 0 && !exactMatch;

  const selectExisting = (item) => {
    onSelect(String(item.id), '');
    setOpen(false);
    setFocused(false);
    setQuery('');
  };

  const selectNew = () => {
    onNewItem(query.trim());
    setOpen(false);
    setFocused(false);
    setQuery('');
  };

  return (
    <div className="item-combo-wrap" ref={wrapRef}>
      <div className="item-combo-input-row">
        <IconSearch size={ICON_SM} className="item-combo-icon" />
        <input
          ref={inputRef}
          type="text"
          className="item-combo-input"
          placeholder={loading ? 'Loading items…' : allowCreateNew ? 'Search or type new item name…' : 'Search items…'}
          value={displayText}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={handleFocus}
          onBlur={handleBlur}
          disabled={disabled || loading}
          aria-label={`Item for line ${lineIdx + 1}`}
          autoComplete="off"
        />
        {(value || newItemName) && (
          <button
            type="button"
            className="item-combo-clear"
            onMouseDown={e => { e.preventDefault(); onSelect('', ''); setQuery(''); }}
            tabIndex={-1}
            aria-label="Clear selection"
          >×</button>
        )}
      </div>

      {open && (
        <div className="item-combo-dropdown">
          {loading && <div className="item-combo-opt item-combo-muted">Loading items…</div>}

          {!loading && filtered.length === 0 && !showCreateOption && (
            <div className="item-combo-opt item-combo-muted">No items found</div>
          )}

          {!loading && filtered.map(item => (
            <div
              key={item.id}
              className={`item-combo-opt${String(item.id) === String(value) ? ' item-combo-selected' : ''}`}
              onMouseDown={e => { e.preventDefault(); selectExisting(item); }}
            >
              <span className="item-combo-name">{item.name}</span>
              {item.sku && <span className="item-combo-sku">{item.sku}</span>}
              <span className="item-combo-stock">{Number(item.quantity)} {item.unit}</span>
            </div>
          ))}

          {showCreateOption && (
            <div
              className="item-combo-opt item-combo-create"
              onMouseDown={e => { e.preventDefault(); selectNew(); }}
            >
              <IconPlus size={ICON_SM} />
              Add <strong>"{query.trim()}"</strong> as new item
            </div>
          )}
        </div>
      )}

      {/* Badge when a new (not-yet-saved) item is picked */}
      {newItemName && !open && (
        <span className="item-combo-new-badge">New item — will be created on submit</span>
      )}
      {selectedItem && !open && (
        <span className="txn-stock-chip">
          <IconStock size={ICON_SM} /> {Number(selectedItem.quantity)} {selectedItem.unit}
        </span>
      )}
    </div>
  );
}

// ── Multi-line Transaction Form ───────────────────────────────────────────────

function TransactionForm({ mode, companies }) {
  const { toast } = useToast();
  const isIn = mode === 'in';

  const [companyId,    setCompanyId]    = useState('');
  const [globalNote,   setGlobalNote]   = useState('');
  const [lines,        setLines]        = useState([EMPTY_LINE()]);
  const [items,        setItems]        = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [submitting,   setSubmitting]   = useState(false);
  const [results,      setResults]      = useState(null);

  // Load items when company changes
  useEffect(() => {
    if (!companyId) { setItems([]); setLines([EMPTY_LINE()]); return; }
    setLoadingItems(true);
    setLines([EMPTY_LINE()]);
    api.getItems(companyId)
      .then(rows => setItems(rows.filter(r => r.active !== false)))
      .catch(err => { if (!isAuthError(err)) toast.error(err.message); })
      .finally(() => setLoadingItems(false));
  }, [companyId, toast]);

  const addLine    = () => setLines(ls => [...ls, EMPTY_LINE()]);
  const removeLine = (id) => setLines(ls => ls.filter(l => l.id !== id));
  const updateLine = (id, field, value) =>
    setLines(ls => ls.map(l => l.id === id ? { ...l, [field]: value } : l));

  // Called when user selects an existing item OR clears selection
  const handleSelectItem = (lineId, itemId, newItemName) => {
    const item = items.find(i => String(i.id) === String(itemId));
    setLines(ls => ls.map(l => l.id === lineId ? { 
      ...l, 
      itemId, 
      newItemName,
      partCode: item && item.sku ? item.sku : '',
      price: item && item.unit_price ? item.unit_price : '',
      gstRate: item && item.gst_rate ? item.gst_rate : ''
    } : l));
  };

  const itemById = (id) => items.find(i => String(i.id) === String(id));

  // Submit: create any new items first, then record movements
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!companyId) { showToast('Select a company first', 'error'); return; }

    const valid = lines.filter(l => (l.itemId || l.newItemName) && l.quantity && parseFloat(l.quantity) > 0);
    if (valid.length === 0) {
      showToast('Add at least one item with a quantity greater than 0', 'error');
      return;
    }

    setSubmitting(true);
    setResults(null);

    const fn = isIn ? api.stockIn : api.stockOut;
    const ok = [];
    const errors = [];

    // Resolve lines: create new items on the fly, then submit movements
    for (const line of valid) {
      let itemId   = line.itemId;
      let itemName = itemById(itemId)?.name || line.newItemName;

      try {
        // If this is a brand-new item name, create it first
        if (!itemId && line.newItemName) {
          const created = await api.createItem({
            company_id: Number(companyId),
            name:       line.newItemName.trim(),
            sku:        line.partCode.trim() || null,
            quantity:   0,   // stock gets added via the movement below
            unit_price: parseFloat(line.price) || 0,
            gst_rate:   parseFloat(line.gstRate) || 0,
            low_stock_threshold: 10,
          });
          itemId   = String(created.id);
          itemName = created.name;
          // Add new item to local list so subsequent lines can reference it
          setItems(prev => [...prev, created]);
        }

        const res = await fn({
          company_id: Number(companyId),
          item_id:    Number(itemId),
          quantity:   parseFloat(line.quantity),
          note:       (line.note || globalNote) || undefined,
        });
        ok.push({ ...res, itemName });
      } catch (err) {
        if (isAuthError(err)) { setSubmitting(false); return; }
        errors.push({ itemName, message: err.message });
      }
    }

    setResults({ ok, errors });
    if (ok.length > 0) {
      showToast(
        `${isIn ? 'Received' : 'Dispatched'} ${ok.length} item${ok.length > 1 ? 's' : ''} successfully`,
        errors.length > 0 ? 'warning' : 'success'
      );
      // Keep only failed lines
      const failedNames = new Set(errors.map(e => e.itemName));
      setLines(ls => {
        const remaining = ls.filter(l => {
          const name = itemById(l.itemId)?.name || l.newItemName;
          return failedNames.has(name);
        });
        return remaining.length > 0 ? remaining : [EMPTY_LINE()];
      });
      setGlobalNote('');
    }
    setSubmitting(false);
  };

  const filledLines = lines.filter(l => (l.itemId || l.newItemName) && l.quantity);
  const canSubmit   = companyId && filledLines.length > 0;

  return (
    <form className="txn-multi-form" onSubmit={handleSubmit}>

      {/* Company */}
      <div className="form-group">
        <label className="form-label" htmlFor={`txn-co-${mode}`}>Company</label>
        <select
          id={`txn-co-${mode}`}
          className="form-select"
          value={companyId}
          onChange={e => setCompanyId(e.target.value)}
          disabled={submitting}
        >
          <option value="">— select company —</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {/* Line items table */}
      <div className={`txn-lines-wrap ${isIn ? 'txn-lines-in' : 'txn-lines-out'}`}>
        <div className="txn-lines-header">
          <span className="txn-col-item">Item — {isIn ? 'search or type new name' : 'search items'}</span>
          <span className="txn-col-part">Part Code</span>
          <span className="txn-col-qty">Quantity</span>
          {isIn && <span className="txn-col-price">Price (₹)</span>}
          {isIn && <span className="txn-col-gst">GST (%)</span>}
          <span className="txn-col-del" />
        </div>

        <AnimatePresence initial={false}>
          {lines.map((line, idx) => {
            const item = itemById(line.itemId);
            return (
              <motion.div
                key={line.id}
                className="txn-line-row"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.15 }}
              >
                {/* Combobox item picker */}
                <div className="txn-col-item">
                  <ItemCombobox
                    items={items}
                    value={line.itemId}
                    newItemName={line.newItemName}
                    onSelect={(itemId, newItemName) => handleSelectItem(line.id, itemId, newItemName)}
                    onNewItem={(name) => handleSelectItem(line.id, '', name)}
                    disabled={submitting || !companyId}
                    loading={loadingItems}
                    lineIdx={idx}
                    allowCreateNew={isIn}
                  />
                </div>

                {/* Part Code */}
                <div className="txn-col-part">
                  <input
                    type="text"
                    className="form-input"
                    placeholder={!isIn || item ? "—" : "e.g. TC-001"}
                    value={line.partCode}
                    onChange={e => updateLine(line.id, 'partCode', e.target.value)}
                    disabled={submitting || (item && true) || (!isIn)}
                    title={item ? "Part code is bound to the item" : ""}
                  />
                </div>

                {/* Quantity */}
                <div className="txn-col-qty">
                  <input
                    type="number"
                    min="0.001"
                    step="any"
                    className="form-input"
                    placeholder="0"
                    value={line.quantity}
                    onChange={e => updateLine(line.id, 'quantity', e.target.value)}
                    disabled={submitting}
                    aria-label={`Quantity for line ${idx + 1}`}
                  />
                </div>

                {/* Price and GST (Stock In only) */}
                {isIn && (
                  <>
                    <div className="txn-col-price">
                      <input
                        type="number" min="0" step="0.01" className="form-input"
                        placeholder="0.00"
                        value={line.price}
                        onChange={e => updateLine(line.id, 'price', e.target.value)}
                        disabled={submitting || (item && true)} // read-only for existing items
                        title={item ? "Edit price in Item Management" : ""}
                      />
                    </div>
                    <div className="txn-col-gst">
                      <input
                        type="number" min="0" step="0.01" className="form-input"
                        placeholder="0"
                        value={line.gstRate}
                        onChange={e => updateLine(line.id, 'gstRate', e.target.value)}
                        disabled={submitting || (item && true)}
                      />
                    </div>
                  </>
                )}



                {/* Remove */}
                <div className="txn-col-del">
                  <button
                    type="button"
                    className="txn-remove-btn"
                    onClick={() => removeLine(line.id)}
                    disabled={lines.length === 1 || submitting}
                    aria-label="Remove line"
                    title="Remove this line"
                  >
                    <IconDelete size={ICON_MD} />
                  </button>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>

        {/* Add line button */}
        <button
          type="button"
          className="txn-add-line-btn"
          onClick={addLine}
          disabled={submitting || !companyId}
        >
          <IconPlus size={ICON_MD} /> Add another item
        </button>
      </div>

      {/* Global note */}
      <div className="form-group">
        <label className="form-label" htmlFor={`txn-gnote-${mode}`}>
          Shared note for all lines (optional)
        </label>
        <input
          id={`txn-gnote-${mode}`}
          type="text"
          className="form-input"
          placeholder={isIn ? 'e.g. Purchase order #1234' : 'e.g. Workshop job #5678'}
          value={globalNote}
          onChange={e => setGlobalNote(e.target.value)}
          disabled={submitting}
        />
      </div>

      {/* Submit */}
      <div className="txn-form-footer">
        <button
          type="submit"
          className={`btn ${isIn ? 'btn-primary' : 'btn-danger'}`}
          disabled={submitting || !canSubmit}
        >
          {submitting
            ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Processing…</>
            : isIn
              ? <><IconStockIn size={ICON_MD} /> Receive All ({filledLines.length})</>
              : <><IconStockOut size={ICON_MD} /> Dispatch All ({filledLines.length})</>
          }
        </button>
      </div>

      {/* Results */}
      <AnimatePresence>
        {results && (
          <motion.div
            className="txn-results"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            {results.ok.map((r, i) => (
              <div key={i} className="txn-result txn-result-in">
                ✓ <strong>{r.itemName}</strong>: {isIn ? `+${r.quantity_added}` : `-${r.quantity_removed}`} → stock now {r.new_quantity}
              </div>
            ))}
            {results.errors.map((e, i) => (
              <div key={i} className="txn-result txn-result-out">
                ✗ <strong>{e.itemName}</strong>: {e.message}
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </form>
  );
}

// ── Movement History ──────────────────────────────────────────────────────────

function MovementHistory({ companies }) {
  const { toast } = useToast();
  const [companyId, setCompanyId] = useState('');
  const [data,      setData]      = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [pageIndex, setPageIndex] = useState(0); // 0-based, for the "Page N of M" label

  // The movements list is keyset-paginated (see backend/lib/keysetCursor.js) —
  // there's no page number to ask the server for, only "give me what comes
  // after this cursor". Prev/Next here is strictly sequential, so a simple
  // stack of the cursors already seen is enough: cursors[0] is always null
  // (the first page), and cursors[i+1] is whatever page i's response said
  // came next. A ref, not state — it doesn't need to trigger a re-render,
  // only `data`/`pageIndex` do.
  const cursorsRef = useRef([null]);

  const load = useCallback(async (cid, idx) => {
    if (!cid) return;
    setLoading(true);
    try {
      const cursor = cursorsRef.current[idx] ?? null;
      const result = await api.getStockMovements(cid, cursor, 30);
      setData(result);
      setPageIndex(idx);
      if (result.nextCursor) cursorsRef.current[idx + 1] = result.nextCursor;
    } catch (err) {
      if (!isAuthError(err)) toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    cursorsRef.current = [null];
    if (companyId) load(companyId, 0);
    else setData(null);
  }, [companyId, load]);

  return (
    <div className="txn-history">
      <div className="txn-history-toolbar">
        <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
          <label className="form-label" htmlFor="hist-company">Company</label>
          <select
            id="hist-company"
            className="form-select"
            value={companyId}
            onChange={e => setCompanyId(e.target.value)}
          >
            <option value="">— select company —</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        {companyId && (
          <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-end' }}
                  onClick={() => load(companyId, pageIndex)} disabled={loading}>
            <IconRefresh size={ICON_MD} /> Refresh
          </button>
        )}
      </div>

      {loading && (
        <div className="skeleton-table" style={{ marginTop: 16 }}>
          <div className="skeleton-thead">
            {[1, 2, 3, 4, 5].map(i => <div key={i} className="skeleton-bar" />)}
          </div>
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="skeleton-row" style={{ opacity: 1 - i * 0.12 }}>
              <div className="skeleton-bar" />
              <div className="skeleton-bar" />
              <div className="skeleton-bar" />
              <div className="skeleton-bar" />
            </div>
          ))}
        </div>
      )}

      {!loading && !companyId && (
        <div className="db-empty" style={{ height: 180 }}>
          <IconCompany size={ICON_LG} /><p>Select a company to view movement history</p>
        </div>
      )}

      {!loading && data && data.movements.length === 0 && (
        <div className="db-empty" style={{ height: 180 }}>
          <IconHistory size={ICON_LG} /><p>No movements found</p>
        </div>
      )}

      {!loading && data && data.movements.length > 0 && (
        <>
          <div className="db-table-wrap" style={{ marginTop: 16 }}>
            <table className="db-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Item</th>
                  <th>Type</th>
                  <th className="num">Qty Change</th>
                  <th>Note</th>
                  <th>By</th>
                </tr>
              </thead>
              <motion.tbody variants={listContainer} initial="initial" animate="animate">
                {data.movements.map(m => (
                  <motion.tr key={m.id} variants={listItem} className={`txn-row ${reasonClass(m.reason)}`}>
                    <td className="db-secondary db-date">{formatDate(m.created_at, { short: true })}</td>
                    <td><strong>{m.item_name}</strong> <span className="db-secondary">({m.item_unit})</span></td>
                    <td><span className={`txn-badge ${reasonClass(m.reason)}`}>{reasonLabel(m.reason)}</span></td>
                    <td className="num num-strong" style={{ color: Number(m.quantity_delta) >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                      {deltaDisplay(m.quantity_delta)}
                    </td>
                    <td className="db-secondary">{m.note || '—'}</td>
                    <td className="db-secondary">{m.performed_by || '—'}</td>
                  </motion.tr>
                ))}
              </motion.tbody>
            </table>
          </div>

          {data.pages > 1 && (
            <div className="txn-pagination">
              <button className="btn btn-secondary btn-sm"
                      disabled={pageIndex <= 0} onClick={() => load(companyId, pageIndex - 1)}>← Prev</button>
              <span className="db-secondary">Page {pageIndex + 1} of {data.pages}</span>
              {/* `nextCursor` is the authoritative "is there more" — `pages` is
                  only an estimate from the count query, taken alongside the
                  page query rather than in the same snapshot. */}
              <button className="btn btn-secondary btn-sm"
                      disabled={!data.nextCursor} onClick={() => load(companyId, pageIndex + 1)}>Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function StockTransactions() {
  const { toast } = useToast();
  const [tab,       setTab]       = useState('in');
  const [companies, setCompanies] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');

  useEffect(() => {
    cached(CACHE_COMPANIES, () => api.getCompanies())
      .then(rows => setCompanies(rows.filter(c => c.active !== false)))
      .catch(err => { if (!isAuthError(err)) setError(err.message); })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div className="txn-page page-enter">
      <div className="txn-tabs">
        {['Stock In', 'Stock Out', 'Movement History'].map(label => (
          <button key={label} className="txn-tab" disabled style={{ opacity: 0.4 }}>{label}</button>
        ))}
      </div>
      <div className="txn-panel txn-panel-full" style={{ marginTop: 16 }}>
        <div className="skeleton-table">
          <div className="skeleton-thead">{[1,2,3,4].map(i=><div key={i} className="skeleton-bar"/>)}</div>
          {[1,2,3].map(i=>(
            <div key={i} className="skeleton-row" style={{opacity:1-i*0.15}}>
              <div className="skeleton-bar"/><div className="skeleton-bar"/><div className="skeleton-bar"/>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
  if (error) return <div className="db-empty" style={{ height: 300 }}><IconAlert size={ICON_LG} /><p>{error}</p></div>;

  return (
    <div className="txn-page page-enter">

      <div className="txn-tabs">
        <button className={`txn-tab txn-tab-in${tab === 'in' ? ' active' : ''}`}
                onClick={() => setTab('in')} id="tab-stock-in">
          <IconStockIn size={ICON_MD} /> Stock In
        </button>
        <button className={`txn-tab txn-tab-out${tab === 'out' ? ' active' : ''}`}
                onClick={() => setTab('out')} id="tab-stock-out">
          <IconStockOut size={ICON_MD} /> Stock Out
        </button>
        <button className={`txn-tab${tab === 'history' ? ' active' : ''}`}
                onClick={() => setTab('history')} id="tab-history">
          <IconHistory size={ICON_MD} /> Movement History
        </button>
      </div>

      <AnimatePresence mode="wait">
        {(tab === 'in' || tab === 'out') && (
          <motion.div
            key={tab}
            className="txn-panel txn-panel-full"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.16 }}
          >
            <div className="txn-panel-header">
              {tab === 'in'
                ? <><IconStockIn size={ICON_LG} className="txn-icon-in" /><div><h2 className="txn-panel-title">Receive Stock</h2><p className="txn-panel-sub">Select existing items or type a new item name to create it</p></div></>
                : <><IconStockOut size={ICON_LG} className="txn-icon-out" /><div><h2 className="txn-panel-title">Dispatch Stock</h2><p className="txn-panel-sub">Select existing items or type a new item name to create it</p></div></>
              }
            </div>
            <TransactionForm key={tab} mode={tab} companies={companies} />
          </motion.div>
        )}

        {tab === 'history' && (
          <motion.div
            key="history"
            className="txn-panel txn-panel-wide"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.16 }}
          >
            <div className="txn-panel-header">
              <IconHistory size={ICON_LG} />
              <div>
                <h2 className="txn-panel-title">Movement History</h2>
                <p className="txn-panel-sub">All stock movements for a company</p>
              </div>
            </div>
            <MovementHistory companies={companies} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
