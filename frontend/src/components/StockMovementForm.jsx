import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { api, isAuthError } from '../api.js';
import { useToast } from '../contexts/ToastContext.jsx';
import {
  IconStockIn, IconStockOut, IconAdjust, IconPlus, IconDelete, IconSearch,
  IconCheck, IconAlert, IconStock, ICON_MD, ICON_SM,
} from '../lib/icons.jsx';

/**
 * The one form behind every stock quantity change — received, dispatched, or
 * a physical-count correction — all funnelled through api.recordStockMovement
 * (POST /api/stock/movements). Used two ways:
 *
 *   - Contextual, single item: pass `lockedItem` (from a row action on the
 *     Stock page). No item picker, no extra lines, mode still switchable.
 *   - Free-standing, batch: omit `lockedItem`. A company selector and a
 *     multi-line item picker appear, matching what the old Stock Transactions
 *     page did — including creating a brand-new item inline while receiving.
 *
 * `onCancel` is only passed when this is embedded in a Modal (Stock page);
 * the standalone page usage omits it and gets no Cancel button.
 */

const MODES = [
  { key: 'in',    label: 'Received',       Icon: IconStockIn,  cls: 'btn-primary' },
  { key: 'out',   label: 'Dispatched',     Icon: IconStockOut, cls: 'btn-danger' },
  { key: 'count', label: 'Correct Count',  Icon: IconAdjust,   cls: 'btn-secondary' },
];

const emptyLine = () => ({ id: Math.random(), itemId: '', newItemName: '', partCode: '', quantity: '', price: '', gstRate: '' });

function lineFromLockedItem(item, mode) {
  return {
    id: item.id, itemId: String(item.id), newItemName: '', partCode: item.sku || '',
    quantity: mode === 'count' ? String(item.quantity) : '',
    price: '', gstRate: '',
  };
}

// ── Searchable item picker — existing items, or "Add '<name>' as new item" ──

function ItemCombobox({ items, value, newItemName, onSelect, onNewItem, disabled, loading, lineIdx, allowCreateNew }) {
  const [query,   setQuery]   = useState('');
  const [open,    setOpen]    = useState(false);
  const [focused, setFocused] = useState(false);
  const wrapRef  = useRef(null);

  const selectedItem = items.find(i => String(i.id) === String(value));
  const displayText  = open || focused ? query
    : selectedItem ? selectedItem.name
    : newItemName  ? `★ ${newItemName} (new)`
    : '';

  const handleFocus = () => {
    setFocused(true);
    setOpen(true);
    setQuery(selectedItem ? selectedItem.name : newItemName || '');
  };

  const handleBlur = () => {
    setTimeout(() => {
      if (!wrapRef.current?.contains(document.activeElement)) {
        setOpen(false); setFocused(false); setQuery('');
      }
    }, 150);
  };

  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false); setFocused(false); setQuery('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = query.trim()
    ? items.filter(i => i.name.toLowerCase().includes(query.toLowerCase()) || (i.sku || '').toLowerCase().includes(query.toLowerCase()))
    : items;

  const exactMatch = items.some(i => i.name.trim().toLowerCase() === query.trim().toLowerCase());
  const showCreateOption = allowCreateNew && query.trim().length > 0 && !exactMatch;

  const selectExisting = (item) => { onSelect(String(item.id), ''); setOpen(false); setFocused(false); setQuery(''); };
  const selectNew = () => { onNewItem(query.trim()); setOpen(false); setFocused(false); setQuery(''); };

  return (
    <div className="item-combo-wrap" ref={wrapRef}>
      <div className="item-combo-input-row">
        <IconSearch size={ICON_SM} className="item-combo-icon" />
        <input
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
          <button type="button" className="item-combo-clear"
                  onMouseDown={e => { e.preventDefault(); onSelect('', ''); setQuery(''); }}
                  tabIndex={-1} aria-label="Clear selection">×</button>
        )}
      </div>

      {open && (
        <div className="item-combo-dropdown">
          {loading && <div className="item-combo-opt item-combo-muted">Loading items…</div>}
          {!loading && filtered.length === 0 && !showCreateOption && (
            <div className="item-combo-opt item-combo-muted">No items found</div>
          )}
          {!loading && filtered.map(item => (
            <div key={item.id}
                 className={`item-combo-opt${String(item.id) === String(value) ? ' item-combo-selected' : ''}`}
                 onMouseDown={e => { e.preventDefault(); selectExisting(item); }}>
              <span className="item-combo-name">{item.name}</span>
              {item.sku && <span className="item-combo-sku">{item.sku}</span>}
              <span className="item-combo-stock">{Number(item.quantity)} {item.unit}</span>
            </div>
          ))}
          {showCreateOption && (
            <div className="item-combo-opt item-combo-create" onMouseDown={e => { e.preventDefault(); selectNew(); }}>
              <IconPlus size={ICON_SM} /> Add <strong>"{query.trim()}"</strong> as new item
            </div>
          )}
        </div>
      )}

      {newItemName && !open && <span className="item-combo-new-badge">New item — will be created on submit</span>}
      {selectedItem && !open && (
        <span className="txn-stock-chip"><IconStock size={ICON_SM} /> {Number(selectedItem.quantity)} {selectedItem.unit}</span>
      )}
    </div>
  );
}

// ── Main form ─────────────────────────────────────────────────────────────

export default function StockMovementForm({ companies, lockedCompanyId, lockedItem, defaultMode, onCancel, onDone }) {
  const { toast } = useToast();
  const isSingle = !!lockedItem;

  const [mode,         setMode]         = useState(defaultMode || (isSingle ? 'count' : 'in'));
  const [companyId,    setCompanyId]    = useState(lockedCompanyId ? String(lockedCompanyId) : '');
  const [items,        setItems]        = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [lines,        setLines]        = useState(() => isSingle ? [lineFromLockedItem(lockedItem, mode)] : [emptyLine()]);
  const [refText,      setRefText]      = useState('');
  const [submitting,   setSubmitting]   = useState(false);
  const [results,      setResults]      = useState(null);

  const allowCreateNew = !isSingle && mode === 'in';

  // Load the item catalog for the picker (batch mode only — a locked item
  // already knows its own current quantity).
  useEffect(() => {
    if (isSingle || !companyId) { setItems([]); return; }
    setLoadingItems(true);
    api.getItems(companyId)
      .then(rows => setItems(rows.filter(r => r.active !== false)))
      .catch(err => { if (!isAuthError(err)) toast.error(err.message); })
      .finally(() => setLoadingItems(false));
  }, [companyId, isSingle, toast]);

  // Switching a batch company clears stale lines/results from the last one.
  useEffect(() => {
    if (isSingle) return;
    setLines([emptyLine()]);
    setResults(null);
  }, [companyId, isSingle]);

  // Correcting a count starts from what the item actually holds right now,
  // not an empty box — that's the whole point of "count", not "delta".
  const handleModeChange = (next) => {
    setMode(next);
    setResults(null);
    if (next === 'count') {
      setLines(ls => ls.map(l => {
        const known = isSingle ? lockedItem : items.find(i => String(i.id) === String(l.itemId));
        return known ? { ...l, quantity: String(known.quantity) } : l;
      }));
    } else {
      setLines(ls => ls.map(l => ({ ...l, quantity: '' })));
    }
  };

  const addLine    = () => setLines(ls => [...ls, emptyLine()]);
  const removeLine = (id) => setLines(ls => ls.filter(l => l.id !== id));
  const updateLine = (id, field, value) => setLines(ls => ls.map(l => l.id === id ? { ...l, [field]: value } : l));

  const handleSelectItem = (lineId, itemId, newItemName) => {
    const item = items.find(i => String(i.id) === String(itemId));
    setLines(ls => ls.map(l => l.id === lineId ? {
      ...l, itemId, newItemName,
      partCode: item?.sku || '',
      price:    item?.unit_price || '',
      gstRate:  item?.gst_rate || '',
      quantity: mode === 'count' && item ? String(item.quantity) : l.quantity,
    } : l));
  };

  const itemById = (id) => (isSingle ? (String(lockedItem.id) === String(id) ? lockedItem : null) : items.find(i => String(i.id) === String(id)));

  const modeMeta = mode === 'count'
    ? { refLabel: 'Reason for correction', placeholder: 'e.g. Physical count correction, damaged stock…', required: true }
    : { refLabel: 'Reference No', placeholder: mode === 'in' ? 'e.g. Purchase order #1234, supplier bill #…' : 'e.g. Workshop job #5678, delivery challan #…', required: true };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!companyId) { toast.error('Select a company first'); return; }
    if (!refText.trim()) { toast.error(`${modeMeta.refLabel} is required`); return; }

    const valid = lines.filter(l => (l.itemId || l.newItemName) && l.quantity !== '' && parseFloat(l.quantity) >= 0);
    if (valid.length === 0) {
      toast.error(mode === 'count' ? 'Enter the corrected quantity' : 'Add at least one item with a quantity greater than 0');
      return;
    }
    if (mode !== 'count' && valid.some(l => parseFloat(l.quantity) <= 0)) {
      toast.error('Quantity must be greater than zero');
      return;
    }

    setSubmitting(true);
    setResults(null);
    const ok = [];
    const errors = [];

    for (const line of valid) {
      let itemId   = line.itemId;
      let itemName = itemById(itemId)?.name || line.newItemName;

      try {
        if (!itemId && line.newItemName) {
          const created = await api.createItem({
            company_id: Number(companyId),
            name:       line.newItemName.trim(),
            sku:        line.partCode.trim() || null,
            quantity:   0,
            unit_price: parseFloat(line.price) || 0,
            gst_rate:   parseFloat(line.gstRate) || 0,
            low_stock_threshold: 10,
          });
          itemId   = String(created.id);
          itemName = created.name;
          setItems(prev => [...prev, created]);
        }

        const res = await api.recordStockMovement({
          company_id:   Number(companyId),
          item_id:      Number(itemId),
          mode,
          quantity:     parseFloat(line.quantity),
          reference_no: mode !== 'count' ? refText.trim() : undefined,
          note:         mode === 'count' ? refText.trim() : undefined,
        });
        ok.push({ ...res, itemName });
      } catch (err) {
        if (isAuthError(err)) { setSubmitting(false); return; }
        errors.push({ itemName, message: err.message });
      }
    }

    setResults({ ok, errors });
    setSubmitting(false);

    if (ok.length > 0) {
      toast[errors.length > 0 ? 'warning' : 'success'](
        mode === 'count'
          ? `${ok.length} item${ok.length > 1 ? 's' : ''} corrected`
          : `${mode === 'in' ? 'Received' : 'Dispatched'} ${ok.length} item${ok.length > 1 ? 's' : ''}`
      );
      if (isSingle) {
        onDone?.();
        return;
      }
      const failedNames = new Set(errors.map(e => e.itemName));
      setLines(ls => {
        const remaining = ls.filter(l => failedNames.has(itemById(l.itemId)?.name || l.newItemName));
        return remaining.length > 0 ? remaining : [emptyLine()];
      });
      setRefText('');
      onDone?.();
    }
  };

  const filledLines = lines.filter(l => (l.itemId || l.newItemName) && l.quantity !== '');
  const canSubmit   = companyId && filledLines.length > 0 && refText.trim();

  return (
    <form className="txn-multi-form" onSubmit={handleSubmit}>
      {/* Mode toggle */}
      <div className="form-group">
        <label className="form-label">What happened</label>
        <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
          {MODES.map(m => (
            <button key={m.key} type="button"
                    className={`btn btn-sm ${mode === m.key ? m.cls : 'btn-secondary'}`}
                    onClick={() => handleModeChange(m.key)} disabled={submitting}>
              <m.Icon size={ICON_MD} /> {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Company (batch mode only — locked mode already has one) */}
      {!lockedCompanyId && (
        <div className="form-group">
          <label className="form-label" htmlFor="sm-company">Company</label>
          <select id="sm-company" className="form-select" value={companyId}
                  onChange={e => setCompanyId(e.target.value)} disabled={submitting}>
            <option value="">— select company —</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      )}

      {isSingle ? (
        <>
          <div className="form-group">
            <label>Item</label>
            <div className="txn-stock-chip" style={{ display: 'inline-flex' }}>
              <IconStock size={ICON_SM} /> {lockedItem.name} — currently {lockedItem.quantity} {lockedItem.unit}
            </div>
          </div>
          <div className="form-group">
            <label>{mode === 'count' ? 'New Quantity' : 'Quantity'} <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input type="number" min="0" step="0.01" autoFocus
                   value={lines[0].quantity}
                   onChange={e => updateLine(lines[0].id, 'quantity', e.target.value)} />
          </div>
        </>
      ) : (
        <div className={`txn-lines-wrap ${mode === 'in' ? 'txn-lines-in' : mode === 'out' ? 'txn-lines-out' : ''}`}>
          <div className="txn-lines-header">
            <span className="txn-col-item">Item — {allowCreateNew ? 'search or type new name' : 'search items'}</span>
            <span className="txn-col-part">Part Code</span>
            <span className="txn-col-qty">{mode === 'count' ? 'New Qty' : 'Quantity'}</span>
            {mode === 'in' && <span className="txn-col-price">Price (₹)</span>}
            {mode === 'in' && <span className="txn-col-gst">GST (%)</span>}
            <span className="txn-col-del" />
          </div>

          <AnimatePresence initial={false}>
            {lines.map((line, idx) => {
              const item = itemById(line.itemId);
              return (
                <motion.div key={line.id} className="txn-line-row"
                            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.15 }}>
                  <div className="txn-col-item">
                    <ItemCombobox items={items} value={line.itemId} newItemName={line.newItemName}
                                  onSelect={(itemId, newItemName) => handleSelectItem(line.id, itemId, newItemName)}
                                  onNewItem={(name) => handleSelectItem(line.id, '', name)}
                                  disabled={submitting || !companyId} loading={loadingItems}
                                  lineIdx={idx} allowCreateNew={allowCreateNew} />
                  </div>
                  <div className="txn-col-part">
                    <input type="text" className="form-input"
                           placeholder={mode !== 'in' || item ? '—' : 'e.g. TC-001'}
                           value={line.partCode} onChange={e => updateLine(line.id, 'partCode', e.target.value)}
                           disabled={submitting || !!item || mode !== 'in'}
                           title={item ? 'Part code is bound to the item' : ''} />
                  </div>
                  <div className="txn-col-qty">
                    <input type="number" min="0" step="any" className="form-input" placeholder="0"
                           value={line.quantity} onChange={e => updateLine(line.id, 'quantity', e.target.value)}
                           disabled={submitting} aria-label={`Quantity for line ${idx + 1}`} />
                  </div>
                  {mode === 'in' && (
                    <>
                      <div className="txn-col-price">
                        <input type="number" min="0" step="0.01" className="form-input" placeholder="0.00"
                               value={line.price} onChange={e => updateLine(line.id, 'price', e.target.value)}
                               disabled={submitting || !!item} title={item ? 'Edit price in Item Management' : ''} />
                      </div>
                      <div className="txn-col-gst">
                        <input type="number" min="0" step="0.01" className="form-input" placeholder="0"
                               value={line.gstRate} onChange={e => updateLine(line.id, 'gstRate', e.target.value)}
                               disabled={submitting || !!item} />
                      </div>
                    </>
                  )}
                  <div className="txn-col-del">
                    <button type="button" className="txn-remove-btn" onClick={() => removeLine(line.id)}
                            disabled={lines.length === 1 || submitting} aria-label="Remove line" title="Remove this line">
                      <IconDelete size={ICON_MD} />
                    </button>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>

          <button type="button" className="txn-add-line-btn" onClick={addLine} disabled={submitting || !companyId}>
            <IconPlus size={ICON_MD} /> Add another item
          </button>
        </div>
      )}

      {/* Reference / reason — required for every mode, meaning changes with it */}
      <div className="form-group">
        <label className="form-label" htmlFor="sm-ref">
          {modeMeta.refLabel} <span style={{ color: 'var(--danger)' }}>*</span>
        </label>
        <input id="sm-ref" type="text" className="form-input" placeholder={modeMeta.placeholder}
               value={refText} onChange={e => setRefText(e.target.value)} disabled={submitting} />
      </div>

      <div className="txn-form-footer">
        {onCancel && <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={submitting}>Cancel</button>}
        <button type="submit" className={`btn ${mode === 'out' ? 'btn-danger' : 'btn-primary'}`} disabled={submitting || !canSubmit}>
          {submitting
            ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Saving…</>
            : mode === 'in'    ? <><IconStockIn size={ICON_MD} /> Receive {isSingle ? '' : `All (${filledLines.length})`}</>
            : mode === 'out'   ? <><IconStockOut size={ICON_MD} /> Dispatch {isSingle ? '' : `All (${filledLines.length})`}</>
            :                    <><IconCheck size={ICON_MD} /> Save Correction{isSingle ? '' : `s (${filledLines.length})`}</>}
        </button>
      </div>

      {!isSingle && (
        <AnimatePresence>
          {results && (
            <motion.div className="txn-results" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              {results.ok.map((r, i) => (
                <div key={i} className="txn-result txn-result-in">
                  ✓ <strong>{r.itemName}</strong>: {r.quantity_delta > 0 ? `+${r.quantity_delta}` : r.quantity_delta} → stock now {r.new_quantity}
                </div>
              ))}
              {results.errors.map((e, i) => (
                <div key={i} className="txn-result txn-result-out">✗ <strong>{e.itemName}</strong>: {e.message}</div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      )}

      {isSingle && results?.errors.length > 0 && (
        <div className="login-error"><IconAlert size={ICON_MD} /><span>{results.errors[0].message}</span></div>
      )}
    </form>
  );
}
