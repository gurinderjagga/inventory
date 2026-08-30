import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { api, isAuthError } from '../api.js';
import { listContainer, listItem } from '../lib/motion.js';
import { useToast } from '../contexts/ToastContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import Modal from '../components/Modal.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { IconAlert, IconCheck, IconCompany, IconDelete, IconEdit, IconSearch, IconShield, IconUserPlus, IconUsers, ICON_MD } from '../lib/icons.jsx';

const EMPTY_FORM = { username: '', password: '', role: 'company_admin', company_id: '' };

export default function Users() {
  const { toast } = useToast();
  const { user }  = useAuth();

  const [users, setUsers]         = useState([]);
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState('');
  const [modal, setModal]         = useState(null);   // null | { mode:'add'|'edit', data }
  const [form, setForm]           = useState(EMPTY_FORM);
  const [formErr, setFormErr]     = useState('');
  const [saving, setSaving]       = useState(false);
  const [confirm, setConfirm]     = useState(null);

  const load = useCallback(async () => {
    try {
      const [u, c] = await Promise.all([api.getUsers(), api.getCompanies()]);
      setUsers(u);
      setCompanies(c);
    } catch (e) {
      if (!isAuthError(e)) toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const filtered = users.filter(u =>
    u.username.toLowerCase().includes(search.toLowerCase()) ||
    (u.company_name || '').toLowerCase().includes(search.toLowerCase())
  );

  const openAdd = () => {
    setForm(EMPTY_FORM);
    setFormErr('');
    setModal({ mode: 'add', data: null });
  };

  const openEdit = (u) => {
    // Password intentionally blank: leaving it empty keeps the existing one.
    setForm({
      username:   u.username,
      password:   '',
      role:       u.role,
      company_id: u.company_id ? String(u.company_id) : '',
    });
    setFormErr('');
    setModal({ mode: 'edit', data: u });
  };

  const closeModal = () => { setModal(null); setSaving(false); };

  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm(f => ({ ...f, [key]: e.target.value })),
  });

  const handleSave = async () => {
    setFormErr('');
    if (form.username.trim().length < 3) return setFormErr('Username must be at least 3 characters.');
    if (/\s/.test(form.username.trim()))  return setFormErr('Username cannot contain spaces.');
    if (modal.mode === 'add' && form.password.length < 8) {
      return setFormErr('Password must be at least 8 characters.');
    }
    if (modal.mode === 'edit' && form.password && form.password.length < 8) {
      return setFormErr('Password must be at least 8 characters, or leave it blank to keep the current one.');
    }
    if (form.role === 'company_admin' && !form.company_id) {
      return setFormErr('A company admin must be assigned to a company.');
    }

    const payload = {
      username: form.username.trim(),
      role:     form.role,
      // The API rejects a company on a platform admin, so send null.
      company_id: form.role === 'company_admin' ? Number(form.company_id) : null,
    };
    if (form.password) payload.password = form.password;

    setSaving(true);
    try {
      if (modal.mode === 'add') {
        await api.createUser(payload);
        toast.success('Account created.');
      } else {
        await api.updateUser(modal.data.id, payload);
        toast.success('Account updated.');
      }
      closeModal();
      load();
    } catch (e) {
      if (!isAuthError(e)) setFormErr(e.message);
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm) return;
    const { id, username } = confirm;
    setConfirm(null);
    try {
      await api.deleteUser(id);
      toast.success(`"${username}" deleted.`);
      load();
    } catch (e) {
      if (!isAuthError(e)) toast.error(e.message, 'Could not delete account');
    }
  };

  if (loading) return <div className="loading-page"><div className="spinner" /><span>Loading…</span></div>;

  return (
    <div className="page-enter">
      <div className="page-header">
        <div className="page-header-text">
          <h2>User Accounts</h2>
          <p>{users.length} {users.length === 1 ? 'account' : 'accounts'}</p>
        </div>
        <div className="flex gap-2 items-center" style={{ flexWrap: 'wrap' }}>
          <div className="search-wrap">
            <IconSearch size={ICON_MD} />
            <input placeholder="Search accounts…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={openAdd}>
            <IconUserPlus size={ICON_MD} /> Add Account
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <IconUsers size={ICON_MD} />
          <h3>No accounts found</h3>
          <p>Create an account using the button above.</p>
        </div>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Username</th><th>Role</th><th>Company</th><th>Created</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <motion.tbody variants={listContainer} initial="initial" animate="animate">
              {filtered.map(u => {
                const isSelf = u.id === user?.id;
                return (
                  <motion.tr key={u.id} variants={listItem}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div className="user-avatar" style={{ width: 28, height: 28, fontSize: 12 }}>
                          {u.username[0]?.toUpperCase()}
                        </div>
                        <span style={{ fontWeight: 600 }}>{u.username}</span>
                        {isSelf && <span className="badge badge-neutral">you</span>}
                      </div>
                    </td>
                    <td>
                      {u.role === 'admin'
                        ? <span className="badge badge-success"><IconShield size={ICON_MD} /> Platform Admin</span>
                        : <span className="badge badge-neutral"><IconCompany size={ICON_MD} /> Company Admin</span>}
                    </td>
                    <td style={{ color: 'var(--text-secondary)' }}>
                      {u.company_name || '—'}
                    </td>
                    <td style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                      {new Date(u.created_at).toLocaleDateString()}
                    </td>
                    <td>
                      <div className="td-actions">
                        <button className="btn btn-secondary btn-sm" onClick={() => openEdit(u)}>
                          <IconEdit size={ICON_MD} /> Edit
                        </button>
                        {/* Deleting your own account is refused by the API; do
                            not offer a button that cannot succeed. */}
                        {!isSelf && (
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => setConfirm({ id: u.id, username: u.username })}
                          >
                            <IconDelete size={ICON_MD} />
                          </button>
                        )}
                      </div>
                    </td>
                  </motion.tr>
                );
              })}
            </motion.tbody>
          </table>
        </div>
      )}

      {/* Add / Edit */}
      <Modal
        isOpen={!!modal}
        onClose={closeModal}
        title={modal?.mode === 'add' ? 'Add User Account' : `Edit: ${modal?.data?.username}`}
        footer={
          <>
            <button className="btn btn-secondary" onClick={closeModal}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving
                ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Saving…</>
                : <><IconCheck size={ICON_MD} /> {modal?.mode === 'add' ? 'Create' : 'Save Changes'}</>}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label>Username <span style={{ color: 'var(--danger)' }}>*</span></label>
          <input type="text" placeholder="e.g. acme_admin" autoComplete="off" {...field('username')} autoFocus />
        </div>

        <div className="form-group">
          <label>
            Password {modal?.mode === 'add' && <span style={{ color: 'var(--danger)' }}>*</span>}
          </label>
          <input type="password" autoComplete="new-password" {...field('password')} />
          <small style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4, display: 'block' }}>
            {modal?.mode === 'add'
              ? 'At least 8 characters. Share it with the user, who can change it after signing in.'
              : 'Leave blank to keep the current password.'}
          </small>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Role <span style={{ color: 'var(--danger)' }}>*</span></label>
            <select {...field('role')}>
              <option value="company_admin">Company Admin</option>
              <option value="admin">Platform Admin</option>
            </select>
          </div>
          <div className="form-group">
            <label>
              Company {form.role === 'company_admin' && <span style={{ color: 'var(--danger)' }}>*</span>}
            </label>
            <select {...field('company_id')} disabled={form.role === 'admin'}>
              <option value="">
                {form.role === 'admin' ? 'Not applicable' : 'Select company…'}
              </option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <small style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4, display: 'block' }}>
              {form.role === 'admin'
                ? 'Platform admins are not tied to a company.'
                : 'This account will only see this company’s data.'}
            </small>
          </div>
        </div>

        {formErr && (
          <div className="login-error">
            <IconAlert size={ICON_MD} /><span>{formErr}</span>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        isOpen={!!confirm}
        title="Delete Account"
        message={<>Delete the account <strong>{confirm?.username}</strong>? They will lose access immediately. This cannot be undone.</>}
        confirmText="Delete"
        danger
        onConfirm={handleDelete}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
