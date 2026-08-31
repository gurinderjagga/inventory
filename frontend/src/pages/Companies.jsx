import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { api, isAuthError } from '../api.js';
import { cached, invalidate, CACHE_COMPANIES } from '../lib/cache.js';
import { listContainer, listItem } from '../lib/motion.js';
import { formatCurrency } from '../lib/format.js';
import { useToast } from '../contexts/ToastContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import Modal from '../components/Modal.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Pagination, { usePagination } from '../components/Pagination.jsx';
import { useTableSort, SortableTh } from '../lib/useTableSort.jsx';
import { IconAlert, IconCheck, IconCompany, IconDelete, IconEdit, IconPlus, IconSearch, IconWarning, ICON_MD } from '../lib/icons.jsx';

const EMPTY_FORM = {
  name: '', email: '', phone: '', address: '',
  gstin: '', legal_name: '', state_code: '', pan: '',
  scheme: 'regular', einvoice_enabled: false,
};

const SORT_COLUMNS = {
  name:            r => r.name,
  email:           r => r.email || '',
  phone:           r => r.phone || '',
  item_count:      r => Number(r.item_count || 0),
  low_stock_count: r => Number(r.low_stock_count || 0),
  stock_value:     r => Number(r.stock_value || 0),
};

// ── Skeleton ──────────────────────────────────────────────────────────────────

function TableSkeleton() {
  return (
    <div className="skeleton-table" style={{ marginTop: 16 }}>
      <div className="skeleton-thead">
        {[1, 2, 3, 4, 5, 6].map(i => <div key={i} className="skeleton-bar" />)}
      </div>
      {[1, 2, 3, 4, 5, 6].map(i => (
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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Companies() {
  const { toast }   = useToast();
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState('');
  const [modal, setModal]         = useState(null);   // null | { mode:'add'|'edit', data }
  const [form, setForm]           = useState(EMPTY_FORM);
  const [formErr, setFormErr]     = useState('');
  const [saving, setSaving]       = useState(false);
  const [confirm, setConfirm]     = useState(null);   // null | { id, name }
  const [deleting, setDeleting]   = useState(false);
  // Snapshot taken when the modal opens, so "has anything changed?" is an
  // honest comparison rather than a guess.
  const [pristine, setPristine]   = useState('');

  const dirty = !!modal && JSON.stringify(form) !== pristine;

  const load = useCallback(async () => {
    try {
      const data = await cached(CACHE_COMPANIES, () => api.getCompanies());
      setCompanies(data);
    } catch (e) {
      if (!isAuthError(e)) toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const filtered = companies.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.email || '').toLowerCase().includes(search.toLowerCase())
  );

  const { sorted, sort, toggle } = useTableSort(filtered, SORT_COLUMNS);
  const pager = usePagination(sorted);

  /* ── Open modal ─────────────────────────────────────── */
  const openAdd = () => {
    setForm(EMPTY_FORM);
    setPristine(JSON.stringify(EMPTY_FORM));
    setFormErr('');
    setModal({ mode: 'add', data: null });
  };

  const openEdit = (company) => {
    const next = {
      name: company.name, email: company.email || '',
      phone: company.phone || '', address: company.address || '',
      gstin: company.gstin || '', legal_name: company.legal_name || '',
      state_code: company.state_code || '', pan: company.pan || '',
      scheme: company.scheme || 'regular', einvoice_enabled: !!company.einvoice_enabled,
    };
    setForm(next);
    setPristine(JSON.stringify(next));
    setFormErr('');
    setModal({ mode: 'edit', data: company });
  };

  const closeModal = () => { setModal(null); setSaving(false); };

  /* ── Save (optimistic) ──────────────────────────────── */
  const handleSave = async () => {
    if (!form.name.trim()) { setFormErr('Company name is required.'); return; }
    setSaving(true);
    setFormErr('');
    try {
      if (modal.mode === 'add') {
        const created = await api.createCompany(form);
        // Optimistic: append to local state immediately, invalidate cache
        invalidate(CACHE_COMPANIES);
        setCompanies(prev => [...prev, {
          ...created,
          item_count: 0, low_stock_count: 0, stock_value: 0,
        }]);
        toast.success('Company created.');
      } else {
        const updated = await api.updateCompany(modal.data.id, form);
        invalidate(CACHE_COMPANIES);
        setCompanies(prev => prev.map(c => c.id === modal.data.id ? { ...c, ...updated } : c));
        toast.success('Company updated.');
      }
      closeModal();
    } catch (e) {
      setFormErr(e.message);
      setSaving(false);
    }
  };

  /* ── Delete (optimistic) ────────────────────────────── */
  const handleDelete = async () => {
    if (!confirm || deleting) return;
    const { id, name } = confirm;
    setDeleting(true);
    // Snapshot for rollback on error
    const snapshot = companies;
    setCompanies(prev => prev.filter(c => c.id !== id));
    setConfirm(null);
    try {
      await api.deleteCompany(id);
      invalidate(CACHE_COMPANIES);
      toast.success(`"${name}" deleted.`);
    } catch (e) {
      // Rollback
      setCompanies(snapshot);
      if (!isAuthError(e)) toast.error(e.message, 'Could not delete company');
    } finally {
      setDeleting(false);
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

  /* ── Render ─────────────────────────────────────────── */
  return (
    <div className="page-enter">
      {/* Header */}
      <div className="page-header">
        <div className="page-header-text">
          <h2>All Companies</h2>
          <p>
            {search
              ? `${filtered.length} of ${companies.length} ${companies.length === 1 ? 'company' : 'companies'} shown`
              : `${companies.length} ${companies.length === 1 ? 'company' : 'companies'} registered`}
          </p>
        </div>
        <div className="flex gap-2 items-center" style={{ flexWrap: 'wrap' }}>
          <div className="search-wrap">
            <IconSearch size={ICON_MD} />
            <input placeholder="Search companies…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={openAdd}>
            <IconPlus size={ICON_MD} /> Add Company
          </button>
        </div>
      </div>

      {/* Skeleton while loading */}
      {loading && <TableSkeleton />}

      {/* Table */}
      {!loading && (
        filtered.length === 0 ? (
          <EmptyState
            Icon={IconCompany}
            query={search}
            onClear={() => setSearch('')}
            noun="companies"
            title="No companies yet"
            hint="Add your first company using the button above."
          />
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <SortableTh sortKey="name"            sort={sort} onToggle={toggle}>Company Name</SortableTh>
                  <SortableTh sortKey="email"           sort={sort} onToggle={toggle}>Email</SortableTh>
                  <SortableTh sortKey="phone"           sort={sort} onToggle={toggle}>Phone</SortableTh>
                  <SortableTh sortKey="item_count"      sort={sort} onToggle={toggle}>Items</SortableTh>
                  <SortableTh sortKey="low_stock_count" sort={sort} onToggle={toggle}>Low Stock</SortableTh>
                  <SortableTh sortKey="stock_value"     sort={sort} onToggle={toggle} align="num">Stock Value</SortableTh>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <motion.tbody variants={listContainer} initial="initial" animate="animate">
                {pager.visible.map(c => (
                  <motion.tr key={c.id} variants={listItem}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <div className="company-avatar-icon"><IconCompany size={ICON_MD} /></div>
                        <span className="cell-primary">{c.name}</span>
                      </div>
                    </td>
                    <td className="cell-muted">{c.email || '—'}</td>
                    <td className="cell-muted">{c.phone || '—'}</td>
                    <td><span className="badge badge-neutral">{c.item_count || 0}</span></td>
                    <td>
                      {(c.low_stock_count || 0) > 0
                        ? <span className="badge badge-warning">{c.low_stock_count} low</span>
                        : <span className="badge badge-success">OK</span>}
                    </td>
                    <td className="num num-strong">{formatCurrency(c.stock_value)}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'nowrap', whiteSpace: 'nowrap' }}>
                        {c.active === false
                          ? <span className="badge badge-neutral">Archived</span>
                          : <span className="badge badge-success">Active</span>}
                        {c.gstin && <span className="badge badge-neutral">GST</span>}
                      </div>
                    </td>
                    <td>
                      <div className="td-actions">
                        <button className="btn btn-secondary btn-sm" onClick={() => openEdit(c)}>
                          <IconEdit size={ICON_MD} /> Edit
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => setConfirm({ id: c.id, name: c.name })}
                                title={`Delete ${c.name}`} aria-label={`Delete ${c.name}`}>
                          <IconDelete size={ICON_MD} />
                        </button>
                      </div>
                    </td>
                  </motion.tr>
                ))}
              </motion.tbody>
            </table>
          </div>
        )
      )}
      <Pagination {...pager} noun="companies" />

      {/* Add / Edit Modal */}
      <Modal
        isOpen={!!modal}
        onClose={closeModal}
        title={modal?.mode === 'add' ? 'Add New Company' : 'Edit Company'}
        onSubmit={handleSave}
        dirty={dirty}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={closeModal}>Cancel</button>
            <button className="btn btn-primary" disabled={saving}>
              {saving ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Saving…</> : <><IconCheck size={ICON_MD} /> {modal?.mode === 'add' ? 'Create' : 'Save Changes'}</>}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label>Company Name <span style={{ color: 'var(--danger)' }}>*</span></label>
          <input type="text" placeholder="e.g. Acme Corp" {...field('name')} autoFocus />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>Email</label>
            <input type="email" placeholder="contact@company.com" {...field('email')} />
          </div>
          <div className="form-group">
            <label>Phone</label>
            <input type="tel" placeholder="+1-555-0000" {...field('phone')} />
          </div>
        </div>
        <div className="form-group">
          <label>Address</label>
          <textarea placeholder="Street, City, State" {...field('address')} />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>GSTIN (optional)</label>
            <input type="text" placeholder="e.g. 27ABCDE1234F1Z5" maxLength={15} {...field('gstin')} />
            <small className="field-hint">Leave blank for a company not registered for GST</small>
          </div>
          <div className="form-group">
            <label>State Code (optional)</label>
            <input type="text" placeholder="e.g. 27" maxLength={2} {...field('state_code')} />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>Legal Name</label>
            <input type="text" placeholder="Registered legal name, if different" {...field('legal_name')} />
          </div>
          <div className="form-group">
            <label>PAN (optional)</label>
            <input type="text" placeholder="e.g. ABCDE1234F" maxLength={10} {...field('pan')} />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>Scheme</label>
            <select {...field('scheme')}>
              <option value="regular">Regular</option>
              <option value="composition">Composition</option>
            </select>
          </div>
          <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 0 }}>
              <input type="checkbox" {...checkboxField('einvoice_enabled')} />
              e-Invoicing enabled
            </label>
          </div>
        </div>
        {formErr && (
          <div className="login-error">
            <IconAlert size={ICON_MD} /><span>{formErr}</span>
          </div>
        )}
      </Modal>

      {/* Confirm delete */}
      <ConfirmDialog
        isOpen={!!confirm}
        title="Delete Company"
        message={<>Delete <strong>{confirm?.name}</strong>? Its stock items will be removed too, and this cannot be undone.</>}
        confirmText="Delete"
        busyText="Deleting…"
        danger
        busy={deleting}
        onConfirm={handleDelete}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
