import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api, isAuthError } from '../api.js';
import { listContainer, listItem, hoverLift } from '../lib/motion.js';
import { formatCurrency, formatDate } from '../lib/format.js';
import { useToast } from '../contexts/ToastContext.jsx';
import Modal from '../components/Modal.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Pagination, { usePagination } from '../components/Pagination.jsx';
import { useTableSort, SortableTh } from '../lib/useTableSort.jsx';
import {
  IconAlert, IconBack, IconCheck, IconChevron, IconCompany, IconGoodsReceipt,
  IconPlus, IconPlusCircle, IconSearch, IconView, IconClose, ICON_MD,
} from '../lib/icons.jsx';

const emptyLine = () => ({ item_id: '', quantity: '1', unit_cost: '0' });
const toNum = (value) => { const n = parseFloat(value); return Number.isFinite(n) ? n : 0; };

const EMPTY_FORM = { supplier_name: '', received_date: '', notes: '' };

const SORT_COLUMNS = {
  supplier_name: r => r.supplier_name,
  received_date: r => new Date(r.received_date).getTime(),
  created_at:    r => new Date(r.created_at).getTime(),
};

export default function GoodsReceipts() {
  const { toast } = useToast();
  const [companies, setCompanies]     = useState([]);
  const [receipts, setReceipts]       = useState([]);
  const [companyItems, setCompanyItems] = useState([]);
  const [refreshKey, setRefreshKey]   = useState(0);
  const [search, setSearch]           = useState('');
  const [loadingComp, setLoadingComp] = useState(true);
  const [loadingList, setLoadingList] = useState(false);
  const [modal, setModal]             = useState(null);   // null | { mode: 'create' }
  const [form, setForm]               = useState(EMPTY_FORM);
  const [lines, setLines]             = useState([]);
  const [createErr, setCreateErr]     = useState('');
  const [creating, setCreating]       = useState(false);
  const [viewReceipt, setViewReceipt] = useState(null);

  const [params, setParams] = useSearchParams();
  const companyParam        = params.get('company');

  const loadCompanies = useCallback(async () => {
    try {
      const data = await api.getCompanies();
      setCompanies(data);
    } catch (e) { if (!isAuthError(e)) toast.error(e.message); }
    finally { setLoadingComp(false); }
  }, [toast]);

  useEffect(() => { loadCompanies(); }, [loadCompanies]);

  const selected = companies.find(c => String(c.id) === companyParam) || null;

  useEffect(() => {
    if (loadingComp || !companyParam || selected) return;
    toast.warning('That company is no longer available.');
    setParams({}, { replace: true });
  }, [loadingComp, companyParam, selected, setParams, toast]);

  const selectedId = selected?.id;

  useEffect(() => {
    if (!selectedId) { setReceipts([]); return; }
    let cancelled = false;
    setLoadingList(true);
    api.getGoodsReceipts(selectedId)
      .then(data => { if (!cancelled) setReceipts(data); })
      .catch(e => { if (!cancelled && !isAuthError(e)) toast.error(e.message); })
      .finally(() => { if (!cancelled) setLoadingList(false); });
    return () => { cancelled = true; };
  }, [selectedId, refreshKey, toast]);

  const selectCompany = (company) => { setSearch(''); setParams({ company: String(company.id) }); };
  const goBack = () => { setSearch(''); setParams({}); };

  /* ── Create modal ───────────────────────────────────── */
  const openCreate = async () => {
    try {
      const items = await api.getItems(selected.id);
      setCompanyItems(items);
      setLines([]);
      setForm(EMPTY_FORM);
      setCreateErr('');
      setModal({ mode: 'create' });
    } catch (e) { if (!isAuthError(e)) toast.error(e.message); }
  };
  const closeModal = () => { setModal(null); setCreating(false); };

  const addLine = () => setLines(l => [...l, emptyLine()]);
  const updateLine = (idx, patch) => setLines(prev => prev.map((l, i) => i === idx ? { ...l, ...patch } : l));
  const removeLine = (idx) => setLines(prev => prev.filter((_, i) => i !== idx));

  const subtotal = lines.reduce((s, l) => s + toNum(l.quantity) * toNum(l.unit_cost), 0);

  const handleSubmit = async () => {
    setCreateErr('');
    if (!form.supplier_name.trim()) { setCreateErr('Supplier name is required.'); return; }
    if (lines.length === 0) { setCreateErr('Add at least one line item.'); return; }
    if (lines.some(l => !l.item_id)) { setCreateErr('All line items must have an item selected.'); return; }
    if (lines.some(l => toNum(l.quantity) <= 0)) { setCreateErr('All quantities must be greater than 0.'); return; }

    setCreating(true);
    try {
      await api.createGoodsReceipt({
        company_id: selected.id,
        supplier_name: form.supplier_name.trim(),
        received_date: form.received_date || null,
        notes: form.notes.trim() || null,
        line_items: lines.map(l => ({
          item_id: Number(l.item_id), quantity: toNum(l.quantity), unit_cost: toNum(l.unit_cost),
        })),
      });
      toast.success('Goods receipt recorded — stock updated.');
      closeModal();
      setRefreshKey(k => k + 1);
    } catch (e) {
      setCreateErr(e.message);
    } finally {
      setCreating(false);
    }
  };

  const openView = async (id) => {
    try { setViewReceipt(await api.getGoodsReceipt(id)); }
    catch (e) { if (!isAuthError(e)) toast.error(e.message); }
  };

  const fld = (key) => ({ value: form[key], onChange: (e) => setForm(f => ({ ...f, [key]: e.target.value })) });

  const filtered = receipts.filter(r => r.supplier_name.toLowerCase().includes(search.toLowerCase()));
  const { sorted, sort, toggle } = useTableSort(filtered, SORT_COLUMNS);
  const pager = usePagination(sorted);

  /* ── Company grid ─────────────────────────────────── */
  if (!selected) {
    if (loadingComp) return <div className="loading-page"><div className="spinner" /><span>Loading…</span></div>;
    return (
      <div className="page-enter">
        <div className="page-header">
          <div className="page-header-text">
            <h2>Select a Company</h2>
            <p>Click a company to view and record its goods receipts</p>
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
            {companies.map(c => (
              <motion.div key={c.id} className="company-card" onClick={() => selectCompany(c)} role="button" tabIndex={0}
                   variants={listItem} {...hoverLift}
                   onKeyDown={e => {
                     if (e.key !== 'Enter' && e.key !== ' ') return;
                     e.preventDefault();
                     selectCompany(c);
                   }}>
                <div className="company-card-icon"><IconCompany size={ICON_MD} /></div>
                <h3>{c.name}</h3>
                <div className="company-card-meta">{c.email || ''}{c.phone ? ' · ' + c.phone : ''}</div>
              </motion.div>
            ))}
          </motion.div>
        )}
      </div>
    );
  }

  /* ── Receipts table ──────────────────────────────── */
  return (
    <div className="page-enter">
      <div className="breadcrumb">
        <button type="button" onClick={goBack} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, padding: 0 }}>
          Goods Receipts
        </button>
        <IconChevron size={ICON_MD} style={{ fontSize: 10 }} />
        <span className="current">{selected.name}</span>
      </div>

      <div className="page-header">
        <div className="page-header-text">
          <h2>{selected.name}</h2>
          <p>
            {search
              ? `${filtered.length} of ${receipts.length} receipt${receipts.length !== 1 ? 's' : ''} shown`
              : `${receipts.length} receipt${receipts.length !== 1 ? 's' : ''} on record`}
          </p>
        </div>
        <div className="flex gap-2 items-center" style={{ flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={goBack}>
            <IconBack size={ICON_MD} /> All Companies
          </button>
          <div className="search-wrap">
            <IconSearch size={ICON_MD} />
            <input placeholder="Search suppliers…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={openCreate}>
            <IconPlus size={ICON_MD} /> Receive Stock
          </button>
        </div>
      </div>

      {loadingList ? (
        <div className="loading-page"><div className="spinner" /></div>
      ) : filtered.length === 0 ? (
        <EmptyState
          Icon={IconGoodsReceipt}
          query={search}
          onClear={() => setSearch('')}
          noun="goods receipts"
          title="No goods receipts yet"
          hint="Record stock arriving from a supplier using the button above."
        />
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <SortableTh sortKey="supplier_name" sort={sort} onToggle={toggle}>Supplier</SortableTh>
                <SortableTh sortKey="received_date" sort={sort} onToggle={toggle}>Received</SortableTh>
                <SortableTh sortKey="created_at"    sort={sort} onToggle={toggle}>Recorded</SortableTh>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <motion.tbody variants={listContainer} initial="initial" animate="animate">
              {pager.visible.map(r => (
                <motion.tr key={r.id} variants={listItem}>
                  <td className="cell-primary">{r.supplier_name}</td>
                  <td className="cell-muted">{formatDate(r.received_date)}</td>
                  <td className="cell-muted">{formatDate(r.created_at)}</td>
                  <td>
                    <div className="td-actions">
                      <button className="btn btn-secondary btn-sm" onClick={() => openView(r.id)}
                              title={`View receipt from ${r.supplier_name}`} aria-label={`View receipt from ${r.supplier_name}`}>
                        <IconView size={ICON_MD} />
                      </button>
                    </div>
                  </td>
                </motion.tr>
              ))}
            </motion.tbody>
          </table>
        </div>
      )}
      <Pagination {...pager} noun="receipts" />

      {/* Create modal */}
      <Modal isOpen={!!modal} onClose={closeModal} size="modal-xl"
        title="Receive Stock"
        onSubmit={handleSubmit}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={closeModal}>Cancel</button>
            <button className="btn btn-primary" disabled={creating}>
              {creating
                ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Saving…</>
                : <><IconCheck size={ICON_MD} /> Record Receipt</>}
            </button>
          </>
        }
      >
        <div className="modal-grid-2" style={{ marginBottom: 16 }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Supplier Name <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input type="text" placeholder="e.g. Acme Wholesale" {...fld('supplier_name')} autoFocus />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Received Date</label>
            <input type="date" {...fld('received_date')} />
          </div>
        </div>
        <div className="form-group">
          <label>Notes (optional)</label>
          <textarea rows={2} placeholder="Delivery note #, condition on arrival…" {...fld('notes')} />
        </div>

        <hr className="divider" />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <label style={{ margin: 0, fontWeight: 700, color: 'var(--text-primary)', fontSize: 13 }}>Line Items</label>
          <button className="btn btn-secondary btn-sm" type="button" onClick={addLine}>
            <IconPlus size={ICON_MD} /> Add Item
          </button>
        </div>

        <div className="table-wrapper" style={{ marginBottom: 16 }}>
          <table>
            <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Unit Cost</th><th className="num">Total</th><th /></tr></thead>
            <tbody>
              {lines.length === 0 ? (
                <tr><td colSpan={5} style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: 13 }}>
                  <IconPlusCircle size={ICON_MD} style={{ marginRight: 8 }} />Click "Add Item" to add line items
                </td></tr>
              ) : lines.map((line, idx) => (
                <tr key={idx}>
                  <td style={{ minWidth: 200 }}>
                    <select value={line.item_id} onChange={e => updateLine(idx, { item_id: e.target.value })}>
                      <option value="">Select item…</option>
                      {companyItems.map(item => (
                        <option key={item.id} value={item.id}>{item.name} ({item.quantity} {item.unit} on hand)</option>
                      ))}
                    </select>
                  </td>
                  <td style={{ width: 110 }}>
                    <input type="number" min="0.01" step="0.01" value={line.quantity}
                      onChange={e => updateLine(idx, { quantity: e.target.value })} />
                  </td>
                  <td style={{ width: 110 }}>
                    <input type="number" min="0" step="0.01" value={line.unit_cost}
                      onChange={e => updateLine(idx, { unit_cost: e.target.value })} />
                  </td>
                  <td className="num num-strong">{formatCurrency(toNum(line.quantity) * toNum(line.unit_cost))}</td>
                  <td style={{ width: 40 }}>
                    <button type="button" className="btn btn-danger btn-icon btn-sm"
                            onClick={() => removeLine(idx)}
                            title="Remove line" aria-label={`Remove line ${idx + 1}`}>
                      <IconClose size={ICON_MD} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {lines.length > 0 && (
          <div className="totals">
            <div className="totals-row grand"><span>Total Cost</span><span className="totals-val">{formatCurrency(subtotal)}</span></div>
          </div>
        )}

        {createErr && <div className="login-error" style={{ marginTop: 12 }}><IconAlert size={ICON_MD} /><span>{createErr}</span></div>}
      </Modal>

      {/* View modal */}
      {viewReceipt && (
        <Modal isOpen={!!viewReceipt} onClose={() => setViewReceipt(null)} title={`Receipt from ${viewReceipt.supplier_name}`} size="modal-lg"
          footer={<button type="button" className="btn btn-secondary" onClick={() => setViewReceipt(null)}>Close</button>}
        >
          <div className="modal-grid-2" style={{ marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>SUPPLIER</div>
              <div style={{ fontWeight: 700 }}>{viewReceipt.supplier_name}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>RECEIVED</div>
              <div style={{ fontWeight: 600 }}>{formatDate(viewReceipt.received_date)}</div>
            </div>
          </div>
          <div className="table-wrapper" style={{ marginBottom: 16 }}>
            <table>
              <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Unit Cost</th><th className="num">Total</th></tr></thead>
              <tbody>
                {viewReceipt.line_items.map(li => (
                  <tr key={li.id}>
                    <td className="cell-primary">{li.item_name}</td>
                    <td className="num">{li.quantity}</td>
                    <td className="num">{formatCurrency(li.unit_cost)}</td>
                    <td className="num num-strong">{formatCurrency(li.quantity * li.unit_cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {viewReceipt.notes && (
            <div style={{ padding: '12px 14px', background: 'var(--bg-input)', borderRadius: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
              <strong style={{ color: 'var(--text-primary)' }}>Notes:</strong> {viewReceipt.notes}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
