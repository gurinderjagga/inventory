import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { api, isAuthError } from '../api.js';
import { listContainer, listItem } from '../lib/motion.js';
import { formatCurrency } from '../lib/format.js';
import { useToast } from '../contexts/ToastContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import Modal from '../components/Modal.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { IconSuccess, IconPending, IconAlert, IconClose, IconCompany, IconDelete, IconFinalize, IconInvoice, IconNewInvoice, IconPdf, IconPlus, IconPlusCircle, IconSearch, IconUp, IconView, ICON_MD } from '../lib/icons.jsx';

/* ── New Invoice line-item state helper ─────────────── */
// quantity and unit_price are held as raw strings while the user types.
// Parsing on every keystroke made partial input impossible: "0." parsed to 0
// and overwrote the field, so a value like 0.5 could never be entered, and
// clearing the box snapped it straight back to 0.
const emptyLine = () => ({ item_id: '', item_name: '', quantity: '1', unit_price: '0' });

/** Parse a partially-typed numeric field for display and arithmetic. */
const toNum = (value) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

export default function Invoices() {
  const { toast }             = useToast();
  const { isAdmin }           = useAuth();
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState('');

  // Create invoice modal
  const [createOpen, setCreateOpen] = useState(false);
  const [companies, setCompanies]   = useState([]);
  const [companyItems, setCompanyItems] = useState([]);
  const [invForm, setInvForm]       = useState({ company_id: '', customer_name: '', customer_email: '', notes: '', tax_rate: '0' });
  const [lines, setLines]           = useState([]);
  const [createErr, setCreateErr]   = useState('');
  const [creating, setCreating]     = useState(false);

  // View invoice modal
  const [viewInv, setViewInv] = useState(null);

  // Confirm dialogs
  const [finalizeConfirm, setFinalizeConfirm] = useState(null);
  const [deleteConfirm, setDeleteConfirm]     = useState(null);

  /* ── Load ───────────────────────────────────────────── */
  const load = useCallback(async () => {
    try {
      const data = await api.getInvoices();
      setInvoices(data);
    } catch (e) { if (!isAuthError(e)) toast.error(e.message); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const filtered = invoices.filter(i =>
    i.invoice_no.toLowerCase().includes(search.toLowerCase()) ||
    i.company_name.toLowerCase().includes(search.toLowerCase()) ||
    i.customer_name.toLowerCase().includes(search.toLowerCase())
  );

  /* ── Open create modal ──────────────────────────────── */
  const openCreate = async () => {
    try {
      const data = await api.getCompanies();
      if (!data.length) { toast.warning('Add a company first before creating an invoice.'); return; }
      setCompanies(data);
      setLines([]);
      setCompanyItems([]);
      setCreateErr('');

      // A company admin has exactly one company, so choose it for them and
      // load its items straight away rather than showing a single-option list.
      if (!isAdmin && data.length === 1) {
        setInvForm({ company_id: String(data[0].id), customer_name: '', customer_email: '', notes: '', tax_rate: '0' });
        setCompanyItems(await api.getItems(data[0].id));
      } else {
        setInvForm({ company_id: '', customer_name: '', customer_email: '', notes: '', tax_rate: '0' });
      }
      setCreateOpen(true);
    } catch (e) { if (!isAuthError(e)) toast.error(e.message); }
  };

  /* ── Company changed → load items ──────────────────── */
  const onCompanyChange = async (cid) => {
    setInvForm(f => ({ ...f, company_id: cid }));
    setLines([]);
    if (!cid) { setCompanyItems([]); return; }
    try {
      const items = await api.getItems(cid);
      setCompanyItems(items);
    } catch (e) { if (!isAuthError(e)) toast.error(e.message); }
  };

  /* ── Line item helpers ──────────────────────────────── */
  const addLine = () => setLines(l => [...l, emptyLine()]);

  const updateLine = (idx, patch) =>
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, ...patch } : l));

  const removeLine = (idx) => setLines(prev => prev.filter((_, i) => i !== idx));

  const onLineItemChange = (idx, itemId) => {
    const item = companyItems.find(i => String(i.id) === String(itemId));
    updateLine(idx, {
      item_id:    itemId,
      item_name:  item?.name || '',
      unit_price: String(item?.unit_price ?? 0),
    });
  };

  /* ── Totals ─────────────────────────────────────────── */
  const subtotal = lines.reduce((s, l) => s + toNum(l.quantity) * toNum(l.unit_price), 0);
  const taxRate  = parseFloat(invForm.tax_rate) || 0;
  const tax      = subtotal * (taxRate / 100);
  const total    = subtotal + tax;

  /* ── Create invoice ─────────────────────────────────── */
  const handleCreate = async () => {
    setCreateErr('');
    if (!invForm.company_id) { setCreateErr('Please select a company.'); return; }
    if (!invForm.customer_name.trim()) { setCreateErr('Customer name is required.'); return; }
    if (lines.length === 0) { setCreateErr('Add at least one line item.'); return; }
    if (lines.some(l => !l.item_id)) { setCreateErr('All line items must have an item selected.'); return; }
    if (lines.some(l => toNum(l.quantity) <= 0)) { setCreateErr('All quantities must be greater than 0.'); return; }

    setCreating(true);
    try {
      // Select values are strings; send real numbers so the payload does not
      // depend on the database coercing "3" into an integer.
      await api.createInvoice({
        company_id:     Number(invForm.company_id),
        customer_name:  invForm.customer_name.trim(),
        customer_email: invForm.customer_email.trim() || null,
        notes:          invForm.notes.trim() || null,
        tax_rate:       taxRate,
        line_items:     lines.map(l => ({
          item_id:    Number(l.item_id),
          item_name:  l.item_name,
          quantity:   toNum(l.quantity),
          unit_price: toNum(l.unit_price),
        })),
      });
      toast.success('Invoice created as draft. Finalize it to deduct stock.');
      setCreateOpen(false);
      load();
    } catch (e) {
      setCreateErr(e.message);
    } finally {
      setCreating(false);
    }
  };

  /* ── View invoice detail ────────────────────────────── */
  const openView = async (id) => {
    try {
      const inv = await api.getInvoice(id);
      setViewInv(inv);
    } catch (e) { if (!isAuthError(e)) toast.error(e.message); }
  };

  /* ── Finalize ───────────────────────────────────────── */
  const handleFinalize = async () => {
    if (!finalizeConfirm) return;
    const { id } = finalizeConfirm;
    setFinalizeConfirm(null);
    try {
      await api.finalizeInvoice(id);
      toast.success('Invoice finalized and stock deducted!');
      load();
    } catch (e) {
      if (!isAuthError(e)) toast.error(e.message, 'Finalization Failed');
    }
  };

  /* ── Delete draft ───────────────────────────────────── */
  const handleDelete = async () => {
    if (!deleteConfirm) return;
    const { id } = deleteConfirm;
    setDeleteConfirm(null);
    try {
      await api.deleteInvoice(id);
      toast.success('Draft deleted.');
      load();
    } catch (e) {
      if (!isAuthError(e)) toast.error(e.message, 'Could not delete invoice');
    }
  };

  const fld = (key) => ({
    value: invForm[key],
    onChange: (e) => setInvForm(f => ({ ...f, [key]: e.target.value })),
  });

  /* ── Render ─────────────────────────────────────────── */
  if (loading) return <div className="loading-page"><div className="spinner" /><span>Loading…</span></div>;

  return (
    <div className="page-enter">
      {/* Header */}
      <div className="page-header">
        <div className="page-header-text">
          <h2>All Invoices</h2>
          <p>{invoices.length} invoice{invoices.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex gap-2 items-center" style={{ flexWrap: 'wrap' }}>
          <div className="search-wrap">
            <IconSearch size={ICON_MD} />
            <input placeholder="Search invoices…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={openCreate}>
            <IconPlus size={ICON_MD} /> New Invoice
          </button>
        </div>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="empty-state">
          <IconInvoice />
          <h3>No invoices yet</h3>
          <p>Create your first invoice using the button above.</p>
        </div>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Invoice #</th><th>Company</th><th>Customer</th>
                <th className="num">Subtotal</th><th className="num">Total</th>
                <th>Status</th><th>Date</th><th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <motion.tbody variants={listContainer} initial="initial" animate="animate">
              {filtered.map(inv => (
                <motion.tr key={inv.id} variants={listItem}>
                  {/* nowrap: an invoice number split across two lines is
                      unreadable as an identifier */}
                  <td className="code">{inv.invoice_no}</td>
                  <td className="cell-primary">{inv.company_name}</td>
                  <td className="cell-muted">{inv.customer_name}</td>
                  <td className="num">{formatCurrency(inv.subtotal)}</td>
                  <td className="num num-strong">{formatCurrency(inv.total)}</td>
                  <td>
                    <span className={`badge ${inv.status === 'finalized' ? 'badge-success' : 'badge-warning'}`}>
                      {inv.status}
                    </span>
                  </td>
                  <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>
                    {new Date(inv.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </td>
                  <td>
                    <div className="td-actions">
                      <button className="btn btn-secondary btn-sm" onClick={() => openView(inv.id)}><IconView size={ICON_MD} /></button>
                      {inv.status === 'draft' ? (
                        <>
                          <button className="btn btn-success btn-sm" onClick={() => setFinalizeConfirm({ id: inv.id, no: inv.invoice_no })}>
                            <IconFinalize size={ICON_MD} /> Finalize
                          </button>
                          <button className="btn btn-danger btn-sm" onClick={() => setDeleteConfirm({ id: inv.id, no: inv.invoice_no })}>
                            <IconDelete size={ICON_MD} />
                          </button>
                        </>
                      ) : (
                        <a href={api.pdfUrl(inv.id)} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">
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
      )}

      {/* ── Create Invoice Modal ─────────────────────────── */}
      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title="Create New Invoice" size="modal-xl"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setCreateOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleCreate} disabled={creating}>
              {creating ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Creating…</> : <><IconNewInvoice size={ICON_MD} /> Create Draft</>}
            </button>
          </>
        }
      >
        {/* Form fields */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Company {isAdmin && <span style={{ color: 'var(--danger)' }}>*</span>}</label>
            {isAdmin ? (
              <select value={invForm.company_id} onChange={e => onCompanyChange(e.target.value)}>
                <option value="">Select company…</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            ) : (
              // Fixed for a company admin — shown for confirmation, not choice.
              <div style={{
                padding: '9px 12px', background: 'var(--bg-input)', borderRadius: 8,
                fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <IconCompany size={ICON_MD} style={{ color: 'var(--text-muted)' }} />
                {companies[0]?.name ?? '—'}
              </div>
            )}
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Customer Name <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input type="text" placeholder="e.g. John Doe" {...fld('customer_name')} />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Customer Email</label>
            <input type="email" placeholder="customer@email.com" {...fld('customer_email')} />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Tax Rate (%)</label>
            <input type="number" min="0" max="100" step="0.5" placeholder="0" {...fld('tax_rate')} />
          </div>
        </div>
        <div className="form-group">
          <label>Notes (optional)</label>
          <textarea rows={2} placeholder="Payment terms, special instructions…" {...fld('notes')} />
        </div>

        <hr className="divider" />

        {/* Line Items */}
        {invForm.company_id ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <label style={{ margin: 0, fontWeight: 700, color: 'var(--text-primary)', fontSize: 13 }}>Line Items</label>
              <button className="btn btn-secondary btn-sm" type="button" onClick={addLine}>
                <IconPlus size={ICON_MD} /> Add Item
              </button>
            </div>

            <div className="table-wrapper" style={{ marginBottom: 16 }}>
              <table>
                <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Unit Price</th><th className="num">Total</th><th /></tr></thead>
                <tbody>
                  {lines.length === 0 ? (
                    <tr><td colSpan={5} style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: 13 }}>
                      <IconPlusCircle size={ICON_MD} style={{ marginRight: 8 }} />Click "Add Item" to add line items
                    </td></tr>
                  ) : lines.map((line, idx) => (
                    <tr key={idx}>
                      <td style={{ minWidth: 200 }}>
                        <select value={line.item_id} onChange={e => onLineItemChange(idx, e.target.value)}>
                          <option value="">Select item…</option>
                          {companyItems.map(item => (
                            <option key={item.id} value={item.id}>
                              {item.name} ({item.quantity} {item.unit})
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={{ width: 90 }}>
                        <input type="number" min="0.01" step="0.01" value={line.quantity}
                          onChange={e => updateLine(idx, { quantity: e.target.value })} />
                      </td>
                      <td style={{ width: 110 }}>
                        <input type="number" min="0" step="0.01" value={line.unit_price}
                          onChange={e => updateLine(idx, { unit_price: e.target.value })} />
                      </td>
                      <td className="num num-strong">
                        {formatCurrency(toNum(line.quantity) * toNum(line.unit_price))}
                      </td>
                      <td style={{ width: 40 }}>
                        <button className="btn btn-danger btn-icon btn-sm" onClick={() => removeLine(idx)}>
                          <IconClose size={ICON_MD} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals */}
            {lines.length > 0 && (
              <div className="totals">
                <div className="totals-row"><span>Subtotal</span><span className="totals-val">{formatCurrency(subtotal)}</span></div>
                {taxRate > 0 && (
                  <div className="totals-row"><span>Tax ({taxRate}%)</span><span className="totals-val">{formatCurrency(tax)}</span></div>
                )}
                <div className="totals-row grand"><span>Total</span><span className="totals-val">{formatCurrency(total)}</span></div>
              </div>
            )}
          </>
        ) : (
          <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>
            <IconUp size={ICON_MD} style={{ fontSize: 24, display: 'block', marginBottom: 8, opacity: .4 }} />
            Select a company above to load available items
          </div>
        )}

        {createErr && (
          <div className="login-error" style={{ marginTop: 12 }}>
            <IconAlert size={ICON_MD} /><span>{createErr}</span>
          </div>
        )}
      </Modal>

      {/* ── View Invoice Modal ──────────────────────────── */}
      {viewInv && (
        <Modal isOpen={!!viewInv} onClose={() => setViewInv(null)} title={`Invoice ${viewInv.invoice_no}`} size="modal-lg"
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setViewInv(null)}>Close</button>
              <a href={api.pdfUrl(viewInv.id)} target="_blank" rel="noreferrer" className="btn btn-primary">
                <IconPdf size={ICON_MD} /> Download PDF
              </a>
            </>
          }
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>FROM</div>
              <div style={{ fontWeight: 700 }}>{viewInv.company_name}</div>
              <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{viewInv.company_email || ''}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>BILL TO</div>
              <div style={{ fontWeight: 700 }}>{viewInv.customer_name}</div>
              <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{viewInv.customer_email || ''}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>DATE</div>
              <div style={{ fontWeight: 600 }}>{new Date(viewInv.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>STATUS</div>
              <span className={`badge ${viewInv.status === 'finalized' ? 'badge-success' : 'badge-warning'}`}
                    style={{ textTransform: 'capitalize' }}>{viewInv.status}</span>
            </div>
          </div>

          <div className="table-wrapper" style={{ marginBottom: 16 }}>
            <table>
              <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Unit Price</th><th className="num">Total</th></tr></thead>
              <tbody>
                {viewInv.line_items.map(li => (
                  <tr key={li.id}>
                    <td className="cell-primary">{li.item_name}</td>
                    <td className="num">{li.quantity}</td>
                    <td className="num">{formatCurrency(li.unit_price)}</td>
                    <td className="num num-strong">{formatCurrency(li.line_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="totals">
            <div className="totals-row"><span>Subtotal</span><span className="totals-val">{formatCurrency(viewInv.subtotal)}</span></div>
            {viewInv.tax_rate > 0 && (
              <div className="totals-row"><span>Tax ({viewInv.tax_rate}%)</span><span className="totals-val">{formatCurrency(viewInv.total - viewInv.subtotal)}</span></div>
            )}
            <div className="totals-row grand"><span>Total</span><span className="totals-val">{formatCurrency(viewInv.total)}</span></div>
          </div>
          {viewInv.notes && (
            <div style={{ marginTop: 16, padding: '12px 14px', background: 'var(--bg-input)', borderRadius: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
              <strong style={{ color: 'var(--text-primary)' }}>Notes:</strong> {viewInv.notes}
            </div>
          )}
        </Modal>
      )}

      {/* Finalize confirm */}
      <ConfirmDialog isOpen={!!finalizeConfirm} title="Finalize Invoice"
        message={<>Finalize <strong>{finalizeConfirm?.no}</strong>? Stock will be permanently deducted. This cannot be undone.</>}
        confirmText="Finalize & Deduct Stock"
        onConfirm={handleFinalize} onCancel={() => setFinalizeConfirm(null)} />

      {/* Delete confirm */}
      <ConfirmDialog isOpen={!!deleteConfirm} title="Delete Draft Invoice"
        message={<>Delete draft <strong>{deleteConfirm?.no}</strong>? This cannot be undone.</>}
        confirmText="Delete" danger
        onConfirm={handleDelete} onCancel={() => setDeleteConfirm(null)} />
    </div>
  );
}
