import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api, isAuthError } from '../api.js';
import { listContainer, listItem } from '../lib/motion.js';
import { formatCurrency, formatDate } from '../lib/format.js';
import { useTableSort, SortableTh } from '../lib/useTableSort.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import Modal from '../components/Modal.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Pagination, { usePagination } from '../components/Pagination.jsx';
import { IconSuccess, IconPending, IconAlert, IconCheck, IconClose, IconCompany, IconDelete, IconEdit, IconFinalize, IconInvoice, IconNewInvoice, IconPdf, IconPlus, IconPlusCircle, IconSearch, IconUp, IconView, IconWarning, IconReverse, ICON_MD } from '../lib/icons.jsx';



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

const EMPTY_INV_FORM = { company_id: '', notes: '' };

/**
 * Client-side mirror of the server's tax engine (routes/invoices.js), for a
 * live preview only — the server recomputes authoritatively on save, the
 * same "approximate preview" precedent already established for the subtotal.
 *
 * Only a company with a GSTIN on the `regular` scheme ever charges tax, and
 * only against a customer with a state on file (place of supply). CGST/SGST
 * are each computed at half the item's own rate — not the full-rate tax
 * divided by two — to match the server's paisa-exact behaviour.
 */
function computeTax(lines, company, customer, companyItems) {
  const chargesTax = !!(company?.gstin && company.scheme === 'regular');
  const needsCustomerState = chargesTax;
  const hasCustomerState = !!customer?.state_code;
  const intraState = chargesTax && hasCustomerState && customer.state_code === company.state_code;

  const itemById = new Map(companyItems.map(i => [String(i.id), i]));
  let subtotal = 0, cgst = 0, sgst = 0, igst = 0;

  for (const l of lines) {
    const lineTotal = toNum(l.quantity) * toNum(l.unit_price);
    subtotal += lineTotal;
    if (!chargesTax || !hasCustomerState) continue;
    const rate = Number(itemById.get(String(l.item_id))?.gst_rate) || 0;
    if (!rate) continue;
    if (intraState) {
      cgst += lineTotal * (rate / 2 / 100);
      sgst += lineTotal * (rate / 2 / 100);
    } else {
      igst += lineTotal * (rate / 100);
    }
  }

  const preRound = subtotal + cgst + sgst + igst;
  // Rounding to the nearest rupee happens because there is tax to round
  // around — an invoice with no actual tax (0% items, or no tax charged at
  // all) stays exact, matching the server (routes/invoices.js).
  const hasTax = cgst > 0 || sgst > 0 || igst > 0;
  const total = hasTax ? Math.round(preRound) : preRound;
  const roundOff = total - preRound;

  return { chargesTax, needsCustomerState, hasCustomerState, intraState, subtotal, cgst, sgst, igst, roundOff, total };
}

/** How each sortable column reads its value out of an invoice row. */
const SORT_COLUMNS = {
  invoice_no:   r => r.invoice_no,
  company_name: r => r.company_name,
  customer_name:r => r.customer_name,
  subtotal:     r => Number(r.subtotal),
  total:        r => Number(r.total),
  status:       r => r.status,
  created_at:   r => new Date(r.created_at).getTime(),
};

/**
 * Compare what the invoice asks for against what is actually on the shelf.
 *
 * Finalizing is the only thing that checks stock server-side, and by then the
 * invoice is written: a failure there used to be a dead end. Doing the same
 * arithmetic while the user is still typing turns it into a correction.
 *
 * Quantities are summed per item, not per line — two lines of the same item
 * draw from one pile, and checking them separately would wave through a draft
 * that cannot possibly finalize.
 */
function stockCheck(lines, companyItems) {
  const byId = new Map(companyItems.map(i => [String(i.id), i]));

  const requested = new Map();
  for (const l of lines) {
    if (!l.item_id) continue;
    const key = String(l.item_id);
    requested.set(key, (requested.get(key) || 0) + toNum(l.quantity));
  }

  const shortfalls = new Map();   // item_id → { name, available, requested }
  for (const [id, qty] of requested) {
    const item = byId.get(id);
    if (!item) continue;
    // Coerced rather than trusted: NUMERIC columns arrive as strings from some
    // Postgres drivers, and a string here would compare the wrong way.
    const available = Number(item.quantity);
    if (qty > available) {
      shortfalls.set(id, { name: item.name, available, requested: qty, unit: item.unit });
    }
  }
  return { requested, shortfalls };
}

export default function Invoices() {
  const { toast }             = useToast();
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState('');
  const [params, setParams]     = useSearchParams();

  // Create / edit invoice modal.
  // null | { mode: 'create' } | { mode: 'edit', id, no }
  const [invModal, setInvModal]     = useState(null);
  const [companies, setCompanies]   = useState([]);
  const [companyItems, setCompanyItems] = useState([]);
  const [invForm, setInvForm]       = useState(EMPTY_INV_FORM);
  const [lines, setLines]           = useState([]);
  const [createErr, setCreateErr]   = useState('');
  const [creating, setCreating]     = useState(false);
  const [openingEdit, setOpeningEdit] = useState(null);   // invoice id being fetched
  const [pristine, setPristine]     = useState('');

  const isEdit = invModal?.mode === 'edit';

  // A stray click on the backdrop used to bin a whole invoice. Comparing
  // against the snapshot taken when the modal opened is the honest test of
  // whether there is anything to lose.
  const dirty = !!invModal && JSON.stringify({ invForm, lines }) !== pristine;

  // View invoice modal
  const [viewInv, setViewInv] = useState(null);

  // Confirm dialogs
  const [finalizeConfirm, setFinalizeConfirm] = useState(null);
  const [reverseConfirm, setReverseConfirm]   = useState(null);
  const [deleteConfirm, setDeleteConfirm]     = useState(null);
  const [working, setWorking]                 = useState(false);   // confirm in flight

  /* ── Load ───────────────────────────────────────────── */
  const load = useCallback(async () => {
    try {
      const data = await api.getInvoices();
      setInvoices(data);
    } catch (e) { if (!isAuthError(e)) toast.error(e.message); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  // `?view=<id>` opens an invoice directly, so the dashboard (and a pasted
  // link) can point at one rather than just dropping you on the list.
  const viewParam = params.get('view');
  useEffect(() => {
    if (!viewParam) return;
    let cancelled = false;
    api.getInvoice(viewParam)
      .then(inv => { if (!cancelled) setViewInv(inv); })
      .catch(e => {
        if (cancelled || isAuthError(e)) return;
        toast.error(e.message, 'Could not open invoice');
      })
      // Consume the parameter either way, so closing the modal does not
      // immediately reopen it and Back behaves.
      .finally(() => { if (!cancelled) setParams({}, { replace: true }); });
    return () => { cancelled = true; };
  }, [viewParam, setParams, toast]);

  const filtered = invoices.filter(i =>
    i.invoice_no.toLowerCase().includes(search.toLowerCase()) ||
    i.company_name.toLowerCase().includes(search.toLowerCase()) ||
    i.customer_name.toLowerCase().includes(search.toLowerCase())
  );

  const { sorted, sort, toggle } = useTableSort(filtered, SORT_COLUMNS);
  const pager = usePagination(sorted);

  /* ── Open create modal ──────────────────────────────── */
  const openCreate = async () => {
    try {
      const data = await api.getCompanies();
      if (!data.length) { toast.warning('Add a company first before creating an invoice.'); return; }
      setCompanies(data);
      setLines([]);
      setCompanyItems([]);
      setCustomerOptions([]);
      setCreateErr('');

      // Choosing from a list of one is pointless, so when only a single company
      // exists, select it and load its items straight away.
      let startForm = EMPTY_INV_FORM;
      if (data.length === 1) {
        startForm = { ...EMPTY_INV_FORM, company_id: String(data[0].id) };
        const items = await api.getItems(data[0].id);
        setCompanyItems(items);
      }
      setInvForm(startForm);
      setPristine(JSON.stringify({ invForm: startForm, lines: [] }));
      setInvModal({ mode: 'create' });
    } catch (e) { if (!isAuthError(e)) toast.error(e.message); }
  };

  /* ── Open edit modal (drafts only) ──────────────────── */
  //
  // The reason this exists: a draft that fails to finalize, almost always
  // because stock moved underneath it, was previously unfixable. Delete and
  // retype every line was the only way forward.
  const openEdit = async (id) => {
    setOpeningEdit(id);
    try {
      const [inv, comps] = await Promise.all([api.getInvoice(id), api.getCompanies()]);
      if (inv.status !== 'draft') {
        toast.error('This invoice has been finalized and can no longer be edited.');
        load();
        return;
      }
      setCompanies(comps);
      const items = await api.getItems(inv.company_id);
      setCompanyItems(items);
      const startForm = {
        company_id:     String(inv.company_id),
        notes:          inv.notes || '',
      };
      const startLines = inv.line_items.map(li => ({
        item_id:    String(li.item_id),
        item_name:  li.item_name,
        quantity:   String(li.quantity),
        unit_price: String(li.unit_price),
      }));
      setInvForm(startForm);
      setLines(startLines);
      setPristine(JSON.stringify({ invForm: startForm, lines: startLines }));
      setCreateErr('');
      setInvModal({ mode: 'edit', id: inv.id, no: inv.invoice_no });
    } catch (e) {
      if (!isAuthError(e)) toast.error(e.message, 'Could not open invoice');
    } finally {
      setOpeningEdit(null);
    }
  };

  const closeInvModal = () => { setInvModal(null); setCreating(false); };

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

  /**
   * Fold repeated items into one line, summing their quantities.
   *
   * Two lines of the same item are almost always a mistake, and they read as
   * two separate stock draws when they are really one. Offered rather than
   * done automatically: the totals must not change under the user's hands.
   * The first occurrence keeps its position and unit price.
   */
  const mergeDuplicates = () => setLines(prev => {
    const merged = [];
    const seen = new Map();   // item_id → index in `merged`
    for (const line of prev) {
      const key = String(line.item_id);
      if (!line.item_id || !seen.has(key)) {
        seen.set(key, merged.length);
        merged.push({ ...line });
        continue;
      }
      const target = merged[seen.get(key)];
      target.quantity = String(toNum(target.quantity) + toNum(line.quantity));
    }
    return merged;
  });

  const onLineItemChange = (idx, itemId) => {
    const item = companyItems.find(i => String(i.id) === String(itemId));
    updateLine(idx, {
      item_id:    itemId,
      item_name:  item?.name || '',
      unit_price: String(item?.unit_price ?? 0),
    });
  };

  /* ── Totals ─────────────────────────────────────────── */
  const selectedCompany  = companies.find(c => String(c.id) === invForm.company_id);
  const tax = computeTax(lines, selectedCompany, selectedCompany, companyItems);

  /* ── Stock feasibility, recomputed as the user types ── */
  const { requested, shortfalls } = stockCheck(lines, companyItems);

  // Items appearing on more than one line.
  const duplicateCount = lines.reduce((n, l, i) => {
    if (!l.item_id) return n;
    const firstAt = lines.findIndex(o => String(o.item_id) === String(l.item_id));
    return firstAt === i && lines.filter(o => String(o.item_id) === String(l.item_id)).length > 1
      ? n + 1 : n;
  }, 0);

  /* ── Save (create or update) ────────────────────────── */
  const handleSubmit = async () => {
    setCreateErr('');
    if (!invForm.company_id) { setCreateErr('Please select a company.'); return; }
    if (lines.length === 0) { setCreateErr('Add at least one line item.'); return; }
    if (lines.some(l => !l.item_id)) { setCreateErr('All line items must have an item selected.'); return; }
    if (lines.some(l => toNum(l.quantity) <= 0)) { setCreateErr('All quantities must be greater than 0.'); return; }
    if (tax.needsCustomerState && !tax.hasCustomerState) {
      setCreateErr('This company is GST-registered but has no state on file. Tax cannot be computed.');
      return;
    }
    if (shortfalls.size > 0) {
      const [first] = [...shortfalls.values()];
      setCreateErr(
        shortfalls.size === 1
          ? `Only ${first.available} ${first.unit} of "${first.name}" in stock, but ${first.requested} is billed. Reduce the quantity or restock first.`
          : `${shortfalls.size} items are billed beyond available stock. Reduce those quantities or restock first.`
      );
      return;
    }

    setCreating(true);
    try {
      // Select values are strings; send real numbers so the payload does not
      // depend on the database coercing "3" into an integer.
      const payload = {
        notes:          invForm.notes.trim() || null,
        line_items:     lines.map(l => ({
          item_id:    Number(l.item_id),
          item_name:  l.item_name,
          quantity:   toNum(l.quantity),
          unit_price: toNum(l.unit_price),
        })),
      };

      if (isEdit) {
        // The company is fixed once the invoice exists — its line items are
        // bound to that tenant's stock.
        await api.updateInvoice(invModal.id, payload);
        toast.success(`${invModal.no} updated. Finalize it to deduct stock.`);
      } else {
        await api.createInvoice({ ...payload, company_id: Number(invForm.company_id) });
        toast.success('Invoice created as draft. Finalize it to deduct stock.');
      }
      closeInvModal();
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
    if (!finalizeConfirm || working) return;
    const { id } = finalizeConfirm;
    // Deducting stock is irreversible; hold the dialog with a spinner rather
    // than closing into silence and inviting a second click.
    setWorking(true);
    try {
      await api.finalizeInvoice(id);
      setWorking(false);
      setFinalizeConfirm(null);
      toast.success('Invoice finalized and stock deducted!');
      load();
    } catch (e) {
      setWorking(false);
      setFinalizeConfirm(null);
      if (isAuthError(e)) return;
      toast.error(e.message, 'Finalization Failed');
      // Almost always insufficient stock. Open the draft so the numbers in
      // that message can be acted on straight away — the error toast stays up
      // beside the editor, and the shortfall is highlighted per line.
      load();
      openEdit(id);
    }
  };

  /* ── Reverse ────────────────────────────────────────── */
  const handleReverse = async () => {
    if (!reverseConfirm || working) return;
    const { id } = reverseConfirm;
    setWorking(true);
    try {
      await api.reverseInvoice(id);
      toast.success('Invoice reversed and stock restored.');
      load();
    } catch (e) {
      if (!isAuthError(e)) toast.error(e.message, 'Could not reverse invoice');
    } finally {
      setWorking(false);
      setReverseConfirm(null);
    }
  };

  /* ── Delete draft ───────────────────────────────────── */
  const handleDelete = async () => {
    if (!deleteConfirm || working) return;
    const { id } = deleteConfirm;
    setWorking(true);
    try {
      await api.deleteInvoice(id);
      toast.success('Draft deleted.');
      load();
    } catch (e) {
      if (!isAuthError(e)) toast.error(e.message, 'Could not delete invoice');
    } finally {
      setWorking(false);
      setDeleteConfirm(null);
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
          <p>
            {search
              ? `${filtered.length} of ${invoices.length} invoice${invoices.length !== 1 ? 's' : ''} shown`
              : `${invoices.length} invoice${invoices.length !== 1 ? 's' : ''}`}
          </p>
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
        <EmptyState
          Icon={IconInvoice}
          query={search}
          onClear={() => setSearch('')}
          noun="invoices"
          title="No invoices yet"
          hint="Create your first invoice using the button above."
        />
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <SortableTh sortKey="invoice_no"    sort={sort} onToggle={toggle}>Invoice #</SortableTh>
                <SortableTh sortKey="company_name"  sort={sort} onToggle={toggle}>Company</SortableTh>
                <SortableTh sortKey="customer_name" sort={sort} onToggle={toggle}>Customer</SortableTh>
                <SortableTh sortKey="subtotal"      sort={sort} onToggle={toggle} align="num">Subtotal</SortableTh>
                <SortableTh sortKey="total"         sort={sort} onToggle={toggle} align="num">Total</SortableTh>
                <SortableTh sortKey="status"        sort={sort} onToggle={toggle}>Status</SortableTh>
                <SortableTh sortKey="created_at"    sort={sort} onToggle={toggle}>Date</SortableTh>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <motion.tbody variants={listContainer} initial="initial" animate="animate">
              {pager.visible.map(inv => (
                <motion.tr key={inv.id} variants={listItem}>
                  {/* nowrap: an invoice number split across two lines is
                      unreadable as an identifier */}
                  <td className="code">{inv.invoice_no}</td>
                  <td className="cell-primary">{inv.company_name}</td>
                  <td className="cell-muted">{inv.customer_name}</td>
                  <td className="num">{formatCurrency(inv.subtotal)}</td>
                  <td className="num num-strong">{formatCurrency(inv.total)}</td>
                  <td>
                    <span className={`badge ${
                      inv.status === 'finalized' ? 'badge-success'
                      : inv.status === 'reversed' ? 'badge-neutral' : 'badge-warning'
                    }`}>
                      {inv.status}
                    </span>
                  </td>
                  <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>
                    {formatDate(inv.created_at)}
                  </td>
                  <td>
                    <div className="td-actions">
                      <button className="btn btn-secondary btn-sm" onClick={() => openView(inv.id)}
                              title={`View ${inv.invoice_no}`} aria-label={`View ${inv.invoice_no}`}>
                        <IconView size={ICON_MD} />
                      </button>
                      {inv.status === 'draft' ? (
                        <>
                          <button className="btn btn-secondary btn-sm" onClick={() => openEdit(inv.id)}
                                  disabled={openingEdit === inv.id}
                                  title={`Edit ${inv.invoice_no}`} aria-label={`Edit ${inv.invoice_no}`}>
                            {openingEdit === inv.id
                              ? <span className="spinner" style={{ width: 13, height: 13, borderWidth: 2 }} />
                              : <IconEdit size={ICON_MD} />}
                          </button>
                          <button className="btn btn-success btn-sm" onClick={() => setFinalizeConfirm({ id: inv.id, no: inv.invoice_no })}>
                            <IconFinalize size={ICON_MD} /> Finalize
                          </button>
                          <button className="btn btn-danger btn-sm" onClick={() => setDeleteConfirm({ id: inv.id, no: inv.invoice_no })}
                                  title={`Delete draft ${inv.invoice_no}`} aria-label={`Delete draft ${inv.invoice_no}`}>
                            <IconDelete size={ICON_MD} />
                          </button>
                        </>
                      ) : (
                        <>
                          <a href={api.pdfUrl(inv.id)} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">
                            <IconPdf size={ICON_MD} /> PDF
                          </a>
                          {inv.status === 'finalized' && (
                            <button className="btn btn-secondary btn-sm" onClick={() => setReverseConfirm({ id: inv.id, no: inv.invoice_no })}
                                    title={`Reverse ${inv.invoice_no}`} aria-label={`Reverse ${inv.invoice_no}`}>
                              <IconReverse size={ICON_MD} /> Reverse
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </motion.tr>
              ))}
            </motion.tbody>
          </table>
        </div>
      )}
      <Pagination {...pager} noun="invoices" />

      {/* ── Create Invoice Modal ─────────────────────────── */}
      <Modal isOpen={!!invModal} onClose={closeInvModal} size="modal-xl"
        title={isEdit ? `Edit Draft ${invModal.no}` : 'Create New Invoice'}
        onSubmit={handleSubmit}
        dirty={dirty}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={closeInvModal}>Cancel</button>
            <button className="btn btn-primary" disabled={creating}>
              {creating
                ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> {isEdit ? 'Saving…' : 'Creating…'}</>
                : isEdit
                  ? <><IconCheck size={ICON_MD} /> Save Changes</>
                  : <><IconNewInvoice size={ICON_MD} /> Create Draft</>}
            </button>
          </>
        }
      >
        {/* Form fields */}
        {/* A class, not an inline grid: the inline version stayed two columns
            at every width, including on a phone. */}
        <div className="modal-grid-2" style={{ marginBottom: 16 }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Company {!isEdit && <span style={{ color: 'var(--danger)' }}>*</span>}</label>
            {!isEdit ? (
              <select value={invForm.company_id} onChange={e => onCompanyChange(e.target.value)}>
                <option value="">Select company…</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            ) : (
              // Fixed on an existing invoice: the line items are bound to that
              // company's stock, so moving it would orphan every one of them.
              <div style={{
                padding: '9px 12px', background: 'var(--bg-input)', borderRadius: 8,
                fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <IconCompany size={ICON_MD} style={{ color: 'var(--text-muted)' }} />
                {companies.find(c => String(c.id) === invForm.company_id)?.name ?? '—'}
              </div>
            )}
          </div>
        </div>
        {selectedCompany && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: -8, marginBottom: 16 }}>
            {tax.chargesTax
              ? (tax.hasCustomerState
                  ? `GST applies, computed per item — ${tax.intraState ? 'CGST + SGST (same state)' : 'IGST (different state)'}.`
                  : 'GST applies — select a customer with a state on file to compute tax.')
              : !selectedCompany.gstin
                ? 'No GST — this company is not registered.'
                : 'No GST — this company is on the composition scheme.'}
          </p>
        )}
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
                  ) : lines.map((line, idx) => {
                    const stockItem = companyItems.find(i => String(i.id) === String(line.item_id));
                    const short     = shortfalls.get(String(line.item_id));
                    // Same item on two lines draws from one pile, so say so
                    // rather than letting each line look individually fine.
                    const splitOver = line.item_id &&
                      lines.filter(l => String(l.item_id) === String(line.item_id)).length > 1;
                    return (
                    <tr key={idx}>
                      <td style={{ minWidth: 200 }}>
                        <select value={line.item_id} onChange={e => onLineItemChange(idx, e.target.value)}>
                          <option value="">Select item…</option>
                          {companyItems.map(item => (
                            <option key={item.id} value={item.id}>
                              {item.name} ({item.quantity} {item.unit}{Number(item.quantity) <= 0 ? ' — out of stock' : ''})
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={{ width: 110 }}>
                        <input type="number" min="0.01" step="0.01" value={line.quantity}
                          className={short ? 'input-invalid' : undefined}
                          aria-invalid={short ? 'true' : undefined}
                          onChange={e => updateLine(idx, { quantity: e.target.value })} />
                        {/* What is actually on the shelf, right where the
                            number is typed — not discovered at finalize. */}
                        {stockItem && (
                          <div className={`line-stock${short ? ' short' : ''}`}>
                            {short
                              ? `only ${stockItem.quantity} ${stockItem.unit} left`
                              : `${stockItem.quantity} ${stockItem.unit} available`}
                            {splitOver && ` · ${requested.get(String(line.item_id))} billed in total`}
                          </div>
                        )}
                      </td>
                      <td style={{ width: 110 }}>
                        <input type="number" min="0" step="0.01" value={line.unit_price}
                          onChange={e => updateLine(idx, { unit_price: e.target.value })} />
                      </td>
                      <td className="num num-strong">
                        {formatCurrency(toNum(line.quantity) * toNum(line.unit_price))}
                      </td>
                      <td style={{ width: 40 }}>
                        <button type="button" className="btn btn-danger btn-icon btn-sm"
                                onClick={() => removeLine(idx)}
                                title="Remove line" aria-label={`Remove line ${idx + 1}`}>
                          <IconClose size={ICON_MD} />
                        </button>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Repeated items — offered as a fix, never applied silently. */}
            {duplicateCount > 0 && (
              <div className="stock-warning" role="status">
                <IconWarning size={ICON_MD} />
                <div style={{ flex: 1 }}>
                  <strong>
                    {duplicateCount === 1
                      ? 'One item appears on more than one line.'
                      : `${duplicateCount} items appear on more than one line.`}
                  </strong>
                  <div>They draw from the same stock, so they are billed as one quantity.</div>
                </div>
                <button type="button" className="btn btn-secondary btn-sm"
                        style={{ flexShrink: 0, alignSelf: 'center' }}
                        onClick={mergeDuplicates}>
                  Merge lines
                </button>
              </div>
            )}

            {/* Stock shortfall — the exact condition that would make finalize
                fail, surfaced while it is still fixable. */}
            {shortfalls.size > 0 && (
              <div className="stock-warning" role="status">
                <IconWarning size={ICON_MD} />
                <div>
                  <strong>
                    {shortfalls.size === 1
                      ? 'One item is billed beyond available stock.'
                      : `${shortfalls.size} items are billed beyond available stock.`}
                  </strong>
                  <ul>
                    {[...shortfalls.values()].map(s => (
                      <li key={s.name}>
                        {s.name} — billing {s.requested} {s.unit}, {s.available} in stock
                      </li>
                    ))}
                  </ul>
                  {isEdit
                    ? 'Reduce the quantities or restock before finalizing.'
                    : 'Reduce the quantities, or restock first — finalizing will be refused otherwise.'}
                </div>
              </div>
            )}

            {/* Totals */}
            {lines.length > 0 && (
              <div className="totals">
                <div className="totals-row"><span>Subtotal</span><span className="totals-val">{formatCurrency(tax.subtotal)}</span></div>
                {tax.cgst > 0 && (
                  <div className="totals-row"><span>CGST</span><span className="totals-val">{formatCurrency(tax.cgst)}</span></div>
                )}
                {tax.sgst > 0 && (
                  <div className="totals-row"><span>SGST</span><span className="totals-val">{formatCurrency(tax.sgst)}</span></div>
                )}
                {tax.igst > 0 && (
                  <div className="totals-row"><span>IGST</span><span className="totals-val">{formatCurrency(tax.igst)}</span></div>
                )}
                {tax.roundOff !== 0 && (
                  <div className="totals-row"><span>Round Off</span><span className="totals-val">{tax.roundOff > 0 ? '+' : ''}{formatCurrency(tax.roundOff)}</span></div>
                )}
                <div className="totals-row grand"><span>Total</span><span className="totals-val">{formatCurrency(tax.total)}</span></div>
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
              <button type="button" className="btn btn-secondary" onClick={() => setViewInv(null)}>Close</button>
              {/* Available for drafts too — seeing the document before stock is
                  committed is the whole point of a draft. Named so nobody
                  mistakes a preview for the finalized article. */}
              <a href={api.pdfUrl(viewInv.id)} target="_blank" rel="noreferrer" className="btn btn-primary">
                <IconPdf size={ICON_MD} />
                {viewInv.status === 'draft' ? 'Preview draft PDF' : 'Download PDF'}
              </a>
            </>
          }
        >
          <div className="modal-grid-2" style={{ marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>FROM</div>
              <div style={{ fontWeight: 700 }}>{viewInv.supplier_name || viewInv.company_name}</div>
              <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{viewInv.company_email || ''}</div>
              {viewInv.supplier_gstin && (
                <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>GSTIN: {viewInv.supplier_gstin}</div>
              )}
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>BILL TO</div>
              <div style={{ fontWeight: 700 }}>{viewInv.customer_name}</div>
              <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{viewInv.customer_email || ''}</div>
              {viewInv.place_of_supply_state && (
                <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Place of supply: {viewInv.place_of_supply_state}</div>
              )}
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>DATE</div>
              <div style={{ fontWeight: 600 }}>{formatDate(viewInv.created_at)}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>STATUS</div>
              <span className={`badge ${
                viewInv.status === 'finalized' ? 'badge-success'
                : viewInv.status === 'reversed' ? 'badge-neutral' : 'badge-warning'
              }`} style={{ textTransform: 'capitalize' }}>{viewInv.status}</span>
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
            {(viewInv.cgst_total > 0 || viewInv.sgst_total > 0 || viewInv.igst_total > 0) ? (
              <>
                {viewInv.cgst_total > 0 && (
                  <div className="totals-row"><span>CGST</span><span className="totals-val">{formatCurrency(viewInv.cgst_total)}</span></div>
                )}
                {viewInv.sgst_total > 0 && (
                  <div className="totals-row"><span>SGST</span><span className="totals-val">{formatCurrency(viewInv.sgst_total)}</span></div>
                )}
                {viewInv.igst_total > 0 && (
                  <div className="totals-row"><span>IGST</span><span className="totals-val">{formatCurrency(viewInv.igst_total)}</span></div>
                )}
                {viewInv.round_off != 0 && (
                  <div className="totals-row"><span>Round Off</span><span className="totals-val">{viewInv.round_off > 0 ? '+' : ''}{formatCurrency(viewInv.round_off)}</span></div>
                )}
              </>
            ) : viewInv.tax_rate > 0 && (
              // Pre-Phase-4 invoices only ever had a flat rate — fall back to
              // the old display so they still render the tax they charged.
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
        confirmText="Finalize & Deduct Stock" busyText="Finalizing…" busy={working}
        onConfirm={handleFinalize} onCancel={() => setFinalizeConfirm(null)} />

      {/* Reverse confirm */}
      <ConfirmDialog isOpen={!!reverseConfirm} title="Reverse Invoice"
        message={<>Reverse <strong>{reverseConfirm?.no}</strong>? Stock will be restored, and the invoice can no longer be edited, finalized, or deleted. This cannot be undone.</>}
        confirmText="Reverse & Restore Stock" busyText="Reversing…" busy={working}
        onConfirm={handleReverse} onCancel={() => setReverseConfirm(null)} />

      {/* Delete confirm */}
      <ConfirmDialog isOpen={!!deleteConfirm} title="Delete Draft Invoice"
        message={<>Delete draft <strong>{deleteConfirm?.no}</strong>? This cannot be undone.</>}
        confirmText="Delete" busyText="Deleting…" danger busy={working}
        onConfirm={handleDelete} onCancel={() => setDeleteConfirm(null)} />
    </div>
  );
}
