import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api, isAuthError } from '../api.js';
import { cached, CACHE_COMPANIES } from '../lib/cache.js';
import { listContainer, listItem, hoverLift } from '../lib/motion.js';
import { formatCurrency, formatCurrencyShort, formatDate } from '../lib/format.js';
import { useToast } from '../contexts/ToastContext.jsx';
import Modal from '../components/Modal.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Pagination, { usePagination } from '../components/Pagination.jsx';
import { useTableSort, SortableTh } from '../lib/useTableSort.jsx';
import {
  IconAlert, IconBack, IconCheck, IconChevron, IconCompany, IconInvoice, IconNewInvoice,
  IconEdit, IconDelete, IconFinalize, IconReverse, IconPdf, IconSearch, IconPlus, ICON_MD,
} from '../lib/icons.jsx';

// ── Bill-to line-item state helpers ─────────────────────────────────────────

const EMPTY_BILL_TO = {
  customer_name: '', customer_email: '', customer_address: '', customer_gstin: '',
  customer_state_code: '', delivery_address: '', reverse_charge: false, notes: '',
};

const emptyLine = () => ({ key: Math.random(), item_id: '', quantity: '1', unit_price: '' });

/**
 * Client-side mirror of the server's tax engine (lib/gst.js), for a live
 * preview only. The server recomputes authoritatively on save — this exists
 * so the form doesn't feel dead while typing, not as a source of truth.
 */
function previewLineTax(taxableValue, gstRate, intraState) {
  if (!gstRate) return { cgst: 0, sgst: 0, igst: 0 };
  if (intraState) {
    const half = gstRate / 2;
    return { cgst: (taxableValue * half) / 100, sgst: (taxableValue * half) / 100, igst: 0 };
  }
  return { cgst: 0, sgst: 0, igst: (taxableValue * gstRate) / 100 };
}

const STATUS_BADGE = {
  draft:     'badge-warning',
  finalized: 'badge-success',
  reversed:  'badge-neutral',
};

const SORT_COLUMNS = {
  invoice_no:    r => r.invoice_no,
  customer_name: r => r.customer_name,
  total:         r => Number(r.total),
  status:        r => r.status,
  created_at:    r => new Date(r.created_at).getTime(),
};

// ── Skeletons ────────────────────────────────────────────────────────────────

function TableSkeleton() {
  return (
    <div className="skeleton-table" style={{ marginTop: 16 }}>
      <div className="skeleton-thead">
        {[1, 2, 3, 4, 5].map(i => <div key={i} className="skeleton-bar" />)}
      </div>
      {[1, 2, 3, 4].map(i => (
        <div key={i} className="skeleton-row" style={{ opacity: 1 - i * 0.12 }}>
          <div className="skeleton-bar" /><div className="skeleton-bar" /><div className="skeleton-bar" />
          <div className="skeleton-bar" /><div className="skeleton-bar" />
        </div>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Invoices() {
  const { toast } = useToast();

  const [companies, setCompanies]     = useState([]);
  const [loadingComp, setLoadingComp] = useState(true);
  const [params, setParams]           = useSearchParams();
  const companyParam                  = params.get('company');

  const [invoices, setInvoices]         = useState([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [stats, setStats]               = useState(null);
  const [companyItems, setCompanyItems] = useState([]);
  const [search, setSearch]             = useState('');

  const [modal, setModal]     = useState(null);   // null | { mode: 'add'|'edit'|'view', data }
  const [billTo, setBillTo]   = useState(EMPTY_BILL_TO);
  const [lines, setLines]     = useState([emptyLine()]);
  const [viewData, setViewData] = useState(null); // full invoice + line_items, for the view modal
  const [formErr, setFormErr] = useState('');
  const [saving, setSaving]   = useState(false);
  const [pristine, setPristine] = useState('');

  const [confirm, setConfirm] = useState(null); // null | { type: 'finalize'|'reverse'|'delete', invoice }
  const [acting, setActing]   = useState(false);

  const dirty = !!modal && modal.mode !== 'view' &&
    JSON.stringify({ billTo, lines }) !== pristine;

  /* ── Company picker ───────────────────────────────────────────────── */
  const loadCompanies = useCallback(async () => {
    try {
      setCompanies(await cached(CACHE_COMPANIES, () => api.getCompanies()));
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

  const selectCompany = (company) => { setSearch(''); setParams({ company: String(company.id) }); };
  const goBack = () => { setSearch(''); setParams({}); loadCompanies(); };

  /* ── Load invoices + stats for the selected company ──────────────────── */
  const selectedId = selected?.id;

  const loadInvoices = useCallback(() => {
    if (!selectedId) return;
    setLoadingInvoices(true);
    Promise.all([api.getInvoices(selectedId), api.getInvoiceStats(selectedId)])
      .then(([inv, s]) => { setInvoices(inv); setStats(s); })
      .catch(e => { if (!isAuthError(e)) toast.error(e.message); })
      .finally(() => setLoadingInvoices(false));
  }, [selectedId, toast]);

  useEffect(() => { loadInvoices(); }, [loadInvoices]);

  const filtered = invoices.filter(inv =>
    inv.invoice_no.toLowerCase().includes(search.toLowerCase()) ||
    inv.customer_name.toLowerCase().includes(search.toLowerCase())
  );
  const { sorted, sort, toggle } = useTableSort(filtered, SORT_COLUMNS);
  const pager = usePagination(sorted);

  /* ── Tax preview (client-side, approximate) ──────────────────────────── */
  const chargesTax = !!selected?.gstin && selected?.scheme === 'regular';
  const intraState = chargesTax && billTo.customer_state_code && billTo.customer_state_code === selected?.state_code;

  const previewLines = lines
    .filter(l => l.item_id && Number(l.quantity) > 0)
    .map(l => {
      const item = companyItems.find(i => String(i.id) === String(l.item_id));
      const qty = Number(l.quantity) || 0;
      const price = Number(l.unit_price) || 0;
      const lineTotal = qty * price;
      const tax = previewLineTax(lineTotal, item?.gst_rate || 0, intraState);
      return { ...l, item, lineTotal, ...tax };
    });

  const previewSubtotal = previewLines.reduce((s, l) => s + l.lineTotal, 0);
  const previewCgst     = previewLines.reduce((s, l) => s + l.cgst, 0);
  const previewSgst     = previewLines.reduce((s, l) => s + l.sgst, 0);
  const previewIgst     = previewLines.reduce((s, l) => s + l.igst, 0);
  const previewTotal    = Math.round(previewSubtotal + previewCgst + previewSgst + previewIgst);

  // Requested quantity per item, summed across lines that repeat one item —
  // a shortfall here is only ever a preview; the server re-checks at finalize.
  const shortfalls = previewLines.reduce((acc, l) => {
    if (!l.item) return acc;
    const requested = (acc[l.item.id]?.requested || 0) + Number(l.quantity);
    acc[l.item.id] = { name: l.item.name, requested, available: Number(l.item.quantity) };
    return acc;
  }, {});
  const shortfallList = Object.values(shortfalls).filter(s => s.requested > s.available);

  /* ── Open / close modals ──────────────────────────────────────────────── */
  const loadCompanyItems = useCallback(() => {
    if (!selectedId) return;
    api.getItems(selectedId).then(setCompanyItems).catch(() => {});
  }, [selectedId]);

  const openCreate = () => {
    loadCompanyItems();
    setBillTo(EMPTY_BILL_TO);
    setLines([emptyLine()]);
    setPristine(JSON.stringify({ billTo: EMPTY_BILL_TO, lines: [emptyLine()] }));
    setFormErr('');
    setModal({ mode: 'add', data: null });
  };

  const openEdit = (invoice) => {
    loadCompanyItems();
    api.getInvoice(invoice.id).then(full => {
      const nextBillTo = {
        customer_name: full.customer_name || '', customer_email: full.customer_email || '',
        customer_address: full.customer_address || '', customer_gstin: full.customer_gstin || '',
        customer_state_code: full.customer_state_code || '', delivery_address: full.delivery_address || '',
        reverse_charge: !!full.reverse_charge, notes: full.notes || '',
      };
      const nextLines = full.line_items.map(li => ({
        key: Math.random(), item_id: li.item_id, quantity: String(li.quantity), unit_price: String(li.unit_price),
      }));
      setBillTo(nextBillTo);
      setLines(nextLines);
      setPristine(JSON.stringify({ billTo: nextBillTo, lines: nextLines }));
    }).catch(e => { if (!isAuthError(e)) toast.error(e.message); });
    setFormErr('');
    setModal({ mode: 'edit', data: invoice });
  };

  const openView = (invoice) => {
    setModal({ mode: 'view', data: invoice });
    setViewData(null);
    api.getInvoice(invoice.id).then(setViewData).catch(e => { if (!isAuthError(e)) toast.error(e.message); });
  };

  const closeModal = () => { setModal(null); setSaving(false); };

  const billToField = (key) => ({
    value: billTo[key],
    onChange: (e) => setBillTo(b => ({ ...b, [key]: e.target.value })),
  });

  /* ── Line editing ─────────────────────────────────────────────────────── */
  const updateLine = (key, patch) => setLines(prev => prev.map(l => {
    if (l.key !== key) return l;
    const next = { ...l, ...patch };
    // Prefill the selling price from the item's own price the moment it's picked.
    if (patch.item_id !== undefined && !l.unit_price) {
      const item = companyItems.find(i => String(i.id) === String(patch.item_id));
      if (item) next.unit_price = String(item.unit_price);
    }
    return next;
  }));
  const addLine    = () => setLines(prev => [...prev, emptyLine()]);
  const removeLine = (key) => setLines(prev => prev.length > 1 ? prev.filter(l => l.key !== key) : prev);

  /* ── Save (create/edit draft) ─────────────────────────────────────────── */
  const handleSave = async () => {
    setFormErr('');
    if (!billTo.customer_name.trim())    return setFormErr('Customer name is required.');
    if (!billTo.customer_address.trim()) return setFormErr('Customer address is required.');
    if (chargesTax && !billTo.customer_state_code.trim()) {
      return setFormErr('Customer state is required to compute tax for a GST-registered company.');
    }
    const validLines = lines.filter(l => l.item_id && Number(l.quantity) > 0 && l.unit_price !== '');
    if (validLines.length === 0) return setFormErr('At least one line item is required.');

    const payload = {
      company_id: selected.id,
      ...billTo,
      line_items: validLines.map(l => ({
        item_id: Number(l.item_id), quantity: Number(l.quantity), unit_price: Number(l.unit_price),
      })),
    };

    setSaving(true);
    try {
      if (modal.mode === 'add') {
        const created = await api.createInvoice(payload);
        setInvoices(prev => [created, ...prev]);
        toast.success('Draft created.');
      } else {
        const updated = await api.updateInvoice(modal.data.id, payload);
        setInvoices(prev => prev.map(i => i.id === modal.data.id ? { ...i, ...updated } : i));
        toast.success('Draft updated.');
      }
      closeModal();
      loadInvoices();
    } catch (e) {
      if (!isAuthError(e)) setFormErr(e.message);
      setSaving(false);
    }
  };

  /* ── Finalize / reverse / delete ──────────────────────────────────────── */
  const handleAction = async () => {
    if (!confirm || acting) return;
    const { type, invoice } = confirm;
    setActing(true);
    try {
      if (type === 'delete') {
        await api.deleteInvoice(invoice.id);
        setInvoices(prev => prev.filter(i => i.id !== invoice.id));
        toast.success('Draft deleted.');
      } else {
        const updated = type === 'finalize' ? await api.finalizeInvoice(invoice.id) : await api.reverseInvoice(invoice.id);
        setInvoices(prev => prev.map(i => i.id === invoice.id ? { ...i, ...updated } : i));
        toast.success(type === 'finalize' ? 'Invoice finalized.' : 'Invoice reversed.');
      }
      setConfirm(null);
      loadInvoices();
    } catch (e) {
      if (!isAuthError(e)) toast.error(e.message, 'Could not complete that action');
    } finally {
      setActing(false);
    }
  };

  const CONFIRM_COPY = {
    finalize: {
      title: 'Finalize Invoice',
      message: <>Finalize <strong>{confirm?.invoice.invoice_no}</strong>? This deducts stock and assigns the real invoice number — it cannot be undone, only reversed.</>,
      confirmText: 'Finalize', busyText: 'Finalizing…',
    },
    reverse: {
      title: 'Reverse Invoice',
      message: <>Reverse <strong>{confirm?.invoice.invoice_no}</strong>? This restores the stock it deducted. The invoice record itself is kept, marked reversed.</>,
      confirmText: 'Reverse', busyText: 'Reversing…', danger: true,
    },
    delete: {
      title: 'Delete Draft',
      message: <>Delete the draft <strong>{confirm?.invoice.invoice_no}</strong>? This cannot be undone.</>,
      confirmText: 'Delete', busyText: 'Deleting…', danger: true,
    },
  };

  /* ── Render ───────────────────────────────────────────────────────────── */

  if (!selected) {
    if (loadingComp) return (
      <div className="page-enter">
        <div className="page-header">
          <div className="page-header-text"><h2>Select a Company</h2><p>Click a company to view and manage its invoices</p></div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginTop: 8 }}>
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="skeleton-kpi" style={{ minHeight: 90 }}>
              <div className="skeleton-bar" style={{ height: 12, width: '70%' }} />
              <div className="skeleton-bar" style={{ height: 9, width: '50%' }} />
            </div>
          ))}
        </div>
      </div>
    );
    return (
      <div className="page-enter">
        <div className="page-header">
          <div className="page-header-text"><h2>Select a Company</h2><p>Click a company to view and manage its invoices</p></div>
        </div>
        {companies.length === 0 ? (
          <div className="empty-state"><IconCompany /><h3>No companies yet</h3><p>Add companies from the Companies page first.</p></div>
        ) : (
          <motion.div className="company-cards-grid" variants={listContainer} initial="initial" animate="animate">
            {companies.map(c => (
              <motion.div key={c.id} className="company-card" onClick={() => selectCompany(c)} role="button" tabIndex={0}
                   variants={listItem} {...hoverLift}
                   onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectCompany(c); } }}>
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

  return (
    <div className="page-enter">
      <div className="breadcrumb">
        <button type="button" onClick={goBack} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, padding: 0 }}>
          Invoices
        </button>
        <IconChevron size={ICON_MD} style={{ fontSize: 10 }} />
        <span className="current">{selected.name}</span>
      </div>

      <div className="page-header">
        <div className="page-header-text">
          <h2>{selected.name}</h2>
          <p>
            {stats ? `${stats.total_invoices} invoice${stats.total_invoices === 1 ? '' : 's'} · ${stats.draft_count} draft${stats.draft_count === 1 ? '' : 's'} · ${formatCurrencyShort(stats.finalized_revenue)} finalized` : ' '}
          </p>
        </div>
        <div className="flex gap-2 items-center" style={{ flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={goBack}><IconBack size={ICON_MD} /> All Companies</button>
          <div className="search-wrap">
            <IconSearch size={ICON_MD} />
            <input placeholder="Search invoices…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={openCreate}>
            <IconNewInvoice size={ICON_MD} /> New Invoice
          </button>
        </div>
      </div>

      {loadingInvoices && <TableSkeleton />}

      {!loadingInvoices && (
        filtered.length === 0 ? (
          <EmptyState
            Icon={IconInvoice} query={search} onClear={() => setSearch('')} noun="invoices"
            title="No invoices yet" hint="Create the first one using the button above."
          />
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <SortableTh sortKey="invoice_no"    sort={sort} onToggle={toggle}>Invoice #</SortableTh>
                  <SortableTh sortKey="customer_name" sort={sort} onToggle={toggle}>Customer</SortableTh>
                  <SortableTh sortKey="total"         sort={sort} onToggle={toggle} align="num">Total</SortableTh>
                  <SortableTh sortKey="status"        sort={sort} onToggle={toggle}>Status</SortableTh>
                  <SortableTh sortKey="created_at"    sort={sort} onToggle={toggle}>Date</SortableTh>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <motion.tbody variants={listContainer} initial="initial" animate="animate">
                {pager.visible.map(inv => (
                  <motion.tr key={inv.id} variants={listItem}>
                    <td className="cell-primary">{inv.invoice_no}</td>
                    <td className="cell-muted">{inv.customer_name}</td>
                    <td className="num num-strong">{formatCurrency(inv.total)}</td>
                    <td><span className={`badge ${STATUS_BADGE[inv.status]}`}>{inv.status}</span></td>
                    <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>{formatDate(inv.created_at)}</td>
                    <td>
                      <div className="td-actions">
                        <button className="btn btn-secondary btn-sm" onClick={() => openView(inv)}>View</button>
                        {inv.status === 'draft' && (
                          <>
                            <button className="btn btn-secondary btn-sm" onClick={() => openEdit(inv)}>
                              <IconEdit size={ICON_MD} /> Edit
                            </button>
                            <button className="btn btn-primary btn-sm" onClick={() => setConfirm({ type: 'finalize', invoice: inv })}>
                              <IconFinalize size={ICON_MD} /> Finalize
                            </button>
                            <button className="btn btn-danger btn-sm" onClick={() => setConfirm({ type: 'delete', invoice: inv })}
                                    title="Delete draft" aria-label="Delete draft">
                              <IconDelete size={ICON_MD} />
                            </button>
                          </>
                        )}
                        {inv.status === 'finalized' && (
                          <>
                            <a className="btn btn-secondary btn-sm" href={api.pdfUrl(inv.id)} target="_blank" rel="noreferrer">
                              <IconPdf size={ICON_MD} /> PDF
                            </a>
                            <button className="btn btn-danger btn-sm" onClick={() => setConfirm({ type: 'reverse', invoice: inv })}>
                              <IconReverse size={ICON_MD} /> Reverse
                            </button>
                          </>
                        )}
                        {inv.status === 'reversed' && (
                          <a className="btn btn-secondary btn-sm" href={api.pdfUrl(inv.id)} target="_blank" rel="noreferrer">
                            <IconPdf size={ICON_MD} /> PDF
                          </a>
                        )}
                      </div>
                    </td>
                  </motion.tr>
                ))}
              </motion.tbody>
            </table>
          </div>
        )
      )}
      <Pagination {...pager} noun="invoices" />

      {/* ── Add / Edit ──────────────────────────────────────────────────── */}
      <Modal
        isOpen={!!modal && modal.mode !== 'view'}
        onClose={closeModal}
        size="modal-xl"
        title={modal?.mode === 'add' ? 'New Invoice' : `Edit Draft: ${modal?.data?.invoice_no}`}
        onSubmit={handleSave}
        dirty={dirty}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={closeModal}>Cancel</button>
            <button className="btn btn-primary" disabled={saving}>
              {saving
                ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Saving…</>
                : <><IconCheck size={ICON_MD} /> {modal?.mode === 'add' ? 'Create Draft' : 'Save Changes'}</>}
            </button>
          </>
        }
      >
        <div className="form-row">
          <div className="form-group">
            <label>Customer Name <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input type="text" placeholder="e.g. Riya Sharma" {...billToField('customer_name')} autoFocus />
          </div>
          <div className="form-group">
            <label>Customer Email</label>
            <input type="email" placeholder="optional" {...billToField('customer_email')} />
          </div>
        </div>
        <div className="form-group">
          <label>Customer Address <span style={{ color: 'var(--danger)' }}>*</span></label>
          <textarea placeholder="Street, City, State" {...billToField('customer_address')} />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>Customer GSTIN (optional)</label>
            <input type="text" placeholder="e.g. 27ABCDE1234F1Z5" maxLength={15} {...billToField('customer_gstin')} />
          </div>
          <div className="form-group">
            <label>
              Customer State Code {chargesTax && <span style={{ color: 'var(--danger)' }}>*</span>}
            </label>
            <input type="text" placeholder="e.g. 27" maxLength={2} {...billToField('customer_state_code')} />
            <small className="field-hint">
              {chargesTax
                ? (intraState ? 'Same state as supplier — CGST + SGST applies.' : 'Different state — IGST applies.')
                : 'This company does not charge tax (no GSTIN, or on the composition scheme).'}
            </small>
          </div>
        </div>
        <div className="form-group">
          <label>Delivery Address (optional, if different)</label>
          <textarea placeholder="Leave blank if same as customer address" {...billToField('delivery_address')} />
        </div>
        <div className="form-group">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 0 }}>
            <input
              type="checkbox" checked={billTo.reverse_charge}
              onChange={e => setBillTo(b => ({ ...b, reverse_charge: e.target.checked }))}
            />
            Tax payable under reverse charge
          </label>
        </div>

        <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '16px 0' }} />

        <label>Line Items</label>
        {lines.map((line) => {
          const item = companyItems.find(i => String(i.id) === String(line.item_id));
          const lineTotal = (Number(line.quantity) || 0) * (Number(line.unit_price) || 0);
          return (
            <div key={line.key} className="form-row" style={{ alignItems: 'flex-end', marginBottom: 8 }}>
              <div className="form-group" style={{ flex: 2 }}>
                <select value={line.item_id} onChange={e => updateLine(line.key, { item_id: e.target.value })}>
                  <option value="">Select an item…</option>
                  {companyItems.map(i => (
                    <option key={i.id} value={i.id}>{i.name}{i.sku ? ` (${i.sku})` : ''}</option>
                  ))}
                </select>
                {item && <small className="field-hint">In stock: {Number(item.quantity)} {item.unit} · GST {item.gst_rate}%</small>}
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <input type="number" min="0" step="any" placeholder="Qty"
                       value={line.quantity} onChange={e => updateLine(line.key, { quantity: e.target.value })} />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <input type="number" min="0" step="0.01" placeholder="Unit price"
                       value={line.unit_price} onChange={e => updateLine(line.key, { unit_price: e.target.value })} />
              </div>
              <div className="form-group" style={{ flex: 1, textAlign: 'right', paddingBottom: 8 }}>
                {formatCurrency(lineTotal)}
              </div>
              <button type="button" className="btn btn-secondary btn-sm" style={{ marginBottom: 8 }}
                      onClick={() => removeLine(line.key)} disabled={lines.length <= 1}
                      title="Remove line" aria-label="Remove line">
                <IconDelete size={ICON_MD} />
              </button>
            </div>
          );
        })}
        <button type="button" className="btn btn-secondary btn-sm" onClick={addLine}>
          <IconPlus size={ICON_MD} /> Add another line
        </button>

        {shortfallList.length > 0 && (
          <div className="login-error" style={{ marginTop: 12 }}>
            <IconAlert size={ICON_MD} />
            <span>
              Not enough stock: {shortfallList.map(s => `${s.name} (need ${s.requested}, have ${s.available})`).join(', ')}.
              {' '}This will be re-checked when you finalize.
            </span>
          </div>
        )}

        <div style={{ marginTop: 16, textAlign: 'right', fontSize: 13, lineHeight: 1.8 }}>
          <div>Subtotal: {formatCurrency(previewSubtotal)}</div>
          {previewCgst > 0 && <div>CGST: {formatCurrency(previewCgst)}</div>}
          {previewSgst > 0 && <div>SGST: {formatCurrency(previewSgst)}</div>}
          {previewIgst > 0 && <div>IGST: {formatCurrency(previewIgst)}</div>}
          <div style={{ fontWeight: 600 }}>Estimated Total: {formatCurrency(previewTotal)}</div>
          <small className="field-hint">Estimate only — the server recomputes the authoritative total on save.</small>
        </div>

        <div className="form-group" style={{ marginTop: 12 }}>
          <label>Notes</label>
          <textarea placeholder="Optional" {...billToField('notes')} />
        </div>

        {formErr && <div className="login-error" style={{ marginTop: 12 }}><IconAlert size={ICON_MD} /><span>{formErr}</span></div>}
      </Modal>

      {/* ── View ────────────────────────────────────────────────────────── */}
      <Modal
        isOpen={modal?.mode === 'view'}
        onClose={closeModal}
        size="modal-xl"
        title={`Invoice ${modal?.data?.invoice_no || ''}`}
        footer={<button type="button" className="btn btn-secondary" onClick={closeModal}>Close</button>}
      >
        {!viewData ? (
          <div className="skeleton-table"><div className="skeleton-row"><div className="skeleton-bar" /></div></div>
        ) : (
          <>
            <div className="form-row">
              <div>
                <strong>From</strong>
                <p style={{ margin: '4px 0', fontSize: 13 }}>
                  {viewData.supplier_name}<br />{viewData.supplier_address}<br />
                  {viewData.supplier_gstin && <>GSTIN: {viewData.supplier_gstin}<br /></>}
                  {viewData.supplier_state_code && <>State: {viewData.supplier_state_code}</>}
                </p>
              </div>
              <div>
                <strong>Bill To</strong>
                <p style={{ margin: '4px 0', fontSize: 13 }}>
                  {viewData.customer_name}<br />{viewData.customer_address}<br />
                  {viewData.customer_gstin && <>GSTIN: {viewData.customer_gstin}<br /></>}
                  Place of Supply: {viewData.place_of_supply_state || '—'}
                </p>
              </div>
            </div>
            <p style={{ fontSize: 13 }}>
              <span className={`badge ${STATUS_BADGE[viewData.status]}`}>{viewData.status}</span>
              {' '}· {formatDate(viewData.created_at)}
              {viewData.reverse_charge && ' · Reverse charge applicable'}
            </p>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr><th>Item</th><th>HSN</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Taxable</th></tr>
                </thead>
                <tbody>
                  {viewData.line_items.map(li => (
                    <tr key={li.id}>
                      <td>{li.item_name}</td>
                      <td className="cell-muted">{li.hsn_sac_code || '—'}</td>
                      <td className="num">{Number(li.quantity)}{li.uqc ? ` ${li.uqc}` : ''}</td>
                      <td className="num">{formatCurrency(li.unit_price)}</td>
                      <td className="num">{formatCurrency(li.line_total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 12, textAlign: 'right', fontSize: 13, lineHeight: 1.8 }}>
              <div>Subtotal: {formatCurrency(viewData.subtotal)}</div>
              {Number(viewData.cgst_total) > 0 && <div>CGST: {formatCurrency(viewData.cgst_total)}</div>}
              {Number(viewData.sgst_total) > 0 && <div>SGST: {formatCurrency(viewData.sgst_total)}</div>}
              {Number(viewData.igst_total) > 0 && <div>IGST: {formatCurrency(viewData.igst_total)}</div>}
              {Number(viewData.round_off) !== 0 && <div>Round Off: {formatCurrency(viewData.round_off)}</div>}
              <div style={{ fontWeight: 600 }}>Total: {formatCurrency(viewData.total)}</div>
            </div>
            {viewData.notes && <p style={{ fontSize: 13, marginTop: 12 }}><strong>Notes:</strong> {viewData.notes}</p>}
            {viewData.status !== 'draft' && (
              <a className="btn btn-secondary" style={{ marginTop: 12 }} href={api.pdfUrl(viewData.id)} target="_blank" rel="noreferrer">
                <IconPdf size={ICON_MD} /> Download PDF
              </a>
            )}
          </>
        )}
      </Modal>

      <ConfirmDialog
        isOpen={!!confirm}
        busy={acting}
        onConfirm={handleAction}
        onCancel={() => setConfirm(null)}
        {...(confirm ? CONFIRM_COPY[confirm.type] : {})}
      />
    </div>
  );
}
