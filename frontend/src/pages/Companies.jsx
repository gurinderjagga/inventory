import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { api, isAuthError } from '../api.js';
import { listContainer, listItem } from '../lib/motion.js';
import { formatCurrency } from '../lib/format.js';
import { useToast } from '../contexts/ToastContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import Modal from '../components/Modal.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { IconAlert, IconCheck, IconCompany, IconDelete, IconEdit, IconPlus, IconSearch, IconWarning, ICON_MD } from '../lib/icons.jsx';

const EMPTY_FORM = { name: '', email: '', phone: '', address: '' };

export default function Companies() {
  const { toast }   = useToast();
  const { isAdmin } = useAuth();
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState('');
  const [modal, setModal]         = useState(null);   // null | { mode:'add'|'edit', data }
  const [form, setForm]           = useState(EMPTY_FORM);
  const [formErr, setFormErr]     = useState('');
  const [saving, setSaving]       = useState(false);
  const [confirm, setConfirm]     = useState(null);   // null | { id, name }

  const load = useCallback(async () => {
    try {
      const data = await api.getCompanies();
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

  /* ── Open modal ─────────────────────────────────────── */
  const openAdd = () => {
    setForm(EMPTY_FORM);
    setFormErr('');
    setModal({ mode: 'add', data: null });
  };

  const openEdit = (company) => {
    setForm({ name: company.name, email: company.email || '', phone: company.phone || '', address: company.address || '' });
    setFormErr('');
    setModal({ mode: 'edit', data: company });
  };

  const closeModal = () => { setModal(null); setSaving(false); };

  /* ── Save ───────────────────────────────────────────── */
  const handleSave = async () => {
    if (!form.name.trim()) { setFormErr('Company name is required.'); return; }
    setSaving(true);
    setFormErr('');
    try {
      if (modal.mode === 'add') {
        await api.createCompany(form);
        toast.success('Company created.');
      } else {
        await api.updateCompany(modal.data.id, form);
        toast.success('Company updated.');
      }
      closeModal();
      load();
    } catch (e) {
      setFormErr(e.message);
      setSaving(false);
    }
  };

  /* ── Delete ─────────────────────────────────────────── */
  const handleDelete = async () => {
    if (!confirm) return;
    const { id, name } = confirm;
    // Close the dialog whatever happens — leaving it open on failure made the
    // Delete button look dead while the real reason sat in a toast behind it.
    setConfirm(null);
    try {
      await api.deleteCompany(id);
      toast.success(`"${name}" deleted.`);
      load();
    } catch (e) {
      if (!isAuthError(e)) toast.error(e.message, 'Could not delete company');
    }
  };

  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm(f => ({ ...f, [key]: e.target.value })),
  });

  /* ── Render ─────────────────────────────────────────── */
  if (loading) return <div className="loading-page"><div className="spinner" /><span>Loading…</span></div>;

  return (
    <div className="page-enter">
      {/* Header */}
      <div className="page-header">
        <div className="page-header-text">
          <h2>{isAdmin ? 'All Companies' : 'My Company'}</h2>
          <p>
            {isAdmin
              ? `${companies.length} ${companies.length === 1 ? 'company' : 'companies'} registered`
              : 'Details shown on your invoices'}
          </p>
        </div>
        {/* Search over a single row is noise, and only a platform admin may
            create companies — the API answers 403 for anyone else. */}
        {isAdmin && (
          <div className="flex gap-2 items-center" style={{ flexWrap: 'wrap' }}>
            <div className="search-wrap">
              <IconSearch size={ICON_MD} />
              <input placeholder="Search companies…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <button className="btn btn-primary" onClick={openAdd}>
              <IconPlus size={ICON_MD} /> Add Company
            </button>
          </div>
        )}
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="empty-state">
          <IconCompany size={ICON_MD} />
          <h3>No companies found</h3>
          <p>Add your first company using the button above.</p>
        </div>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Company Name</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Items</th>
                <th>Low Stock</th>
                <th>Stock Value</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <motion.tbody variants={listContainer} initial="initial" animate="animate">
              {filtered.map(c => (
                <motion.tr key={c.id} variants={listItem}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div className="company-avatar-icon"><IconCompany size={ICON_MD} /></div>
                      <span style={{ fontWeight: 600 }}>{c.name}</span>
                    </div>
                  </td>
                  <td style={{ color: 'var(--text-secondary)' }}>{c.email || '—'}</td>
                  <td style={{ color: 'var(--text-secondary)' }}>{c.phone || '—'}</td>
                  <td><span className="badge badge-neutral">{c.item_count || 0}</span></td>
                  <td>
                    {(c.low_stock_count || 0) > 0
                      ? <span className="badge badge-warning"><IconWarning size={ICON_MD} /> {c.low_stock_count}</span>
                      : <span className="badge badge-success"><IconCheck size={ICON_MD} /> OK</span>}
                  </td>
                  <td style={{ fontWeight: 600 }}>{formatCurrency(c.stock_value)}</td>
                  <td>
                    <div className="td-actions">
                      <button className="btn btn-secondary btn-sm" onClick={() => openEdit(c)}>
                        <IconEdit size={ICON_MD} /> Edit
                      </button>
                      {/* Deleting a tenant is platform-admin only. */}
                      {isAdmin && (
                        <button className="btn btn-danger btn-sm" onClick={() => setConfirm({ id: c.id, name: c.name })}>
                          <IconDelete size={ICON_MD} />
                        </button>
                      )}
                    </div>
                  </td>
                </motion.tr>
              ))}
            </motion.tbody>
          </table>
        </div>
      )}

      {/* Add / Edit Modal */}
      <Modal
        isOpen={!!modal}
        onClose={closeModal}
        title={modal?.mode === 'add' ? 'Add New Company' : 'Edit Company'}
        footer={
          <>
            <button className="btn btn-secondary" onClick={closeModal}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
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
        message={<>Delete <strong>{confirm?.name}</strong>? Its stock items will be removed too, and this cannot be undone. Companies that already have invoices cannot be deleted.</>}
        confirmText="Delete"
        danger
        onConfirm={handleDelete}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
