import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { api, isAuthError } from '../api.js';
import { listContainer, listItem } from '../lib/motion.js';
import { useToast } from '../contexts/ToastContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import Modal from '../components/Modal.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Pagination, { usePagination } from '../components/Pagination.jsx';
import { useTableSort, SortableTh } from '../lib/useTableSort.jsx';
import { formatDate } from '../lib/format.js';
import { IconAlert, IconCheck, IconDelete, IconEdit, IconSearch, IconUserPlus, IconUsers, ICON_MD } from '../lib/icons.jsx';

const EMPTY_FORM = { username: '', password: '' };

const SORT_COLUMNS = {
  username:   r => r.username,
  created_at: r => new Date(r.created_at).getTime(),
};

export default function Users() {
  const { toast } = useToast();
  const { user }  = useAuth();

  const [users, setUsers]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState('');
  const [modal, setModal]         = useState(null);   // null | { mode:'add'|'edit', data }
  const [form, setForm]           = useState(EMPTY_FORM);
  const [formErr, setFormErr]     = useState('');
  const [saving, setSaving]       = useState(false);
  const [confirm, setConfirm]     = useState(null);
  const [deleting, setDeleting]   = useState(false);
  const [pristine, setPristine]   = useState('');

  const dirty = !!modal && JSON.stringify(form) !== pristine;

  const load = useCallback(async () => {
    try {
      setUsers(await api.getUsers());
    } catch (e) {
      if (!isAuthError(e)) toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const filtered = users.filter(u =>
    u.username.toLowerCase().includes(search.toLowerCase())
  );

  const { sorted, sort, toggle } = useTableSort(filtered, SORT_COLUMNS);
  const pager = usePagination(sorted);

  const openAdd = () => {
    setForm(EMPTY_FORM);
    setPristine(JSON.stringify(EMPTY_FORM));
    setFormErr('');
    setModal({ mode: 'add', data: null });
  };

  const openEdit = (u) => {
    // Password intentionally blank: leaving it empty keeps the existing one.
    const next = { username: u.username, password: '' };
    setForm(next);
    setPristine(JSON.stringify(next));
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

    const payload = { username: form.username.trim() };
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
    if (!confirm || deleting) return;
    const { id, username } = confirm;
    setDeleting(true);
    try {
      await api.deleteUser(id);
      toast.success(`"${username}" deleted.`);
      load();
    } catch (e) {
      if (!isAuthError(e)) toast.error(e.message, 'Could not delete account');
    } finally {
      setDeleting(false);
      setConfirm(null);
    }
  };

  if (loading) return <div className="loading-page"><div className="spinner" /><span>Loading…</span></div>;

  return (
    <div className="page-enter">
      <div className="page-header">
        <div className="page-header-text">
          <h2>User Accounts</h2>
          <p>
            {search
              ? `${filtered.length} of ${users.length} ${users.length === 1 ? 'account' : 'accounts'} shown`
              : `${users.length} ${users.length === 1 ? 'account' : 'accounts'} with access`}
          </p>
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
        <EmptyState
          Icon={IconUsers}
          query={search}
          onClear={() => setSearch('')}
          noun="accounts"
          title="No accounts yet"
          hint="Create an account using the button above."
        />
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <SortableTh sortKey="username"   sort={sort} onToggle={toggle}>Username</SortableTh>
                <SortableTh sortKey="created_at" sort={sort} onToggle={toggle}>Created</SortableTh>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <motion.tbody variants={listContainer} initial="initial" animate="animate">
              {pager.visible.map(u => {
                const isSelf = u.id === user?.id;
                return (
                  <motion.tr key={u.id} variants={listItem}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div className="user-avatar" style={{ width: 28, height: 28, fontSize: 12 }}>
                          {u.username[0]?.toUpperCase()}
                        </div>
                        <span className="cell-primary">{u.username}</span>
                        {isSelf && <span className="badge badge-neutral">you</span>}
                      </div>
                    </td>
                    <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>
                      {formatDate(u.created_at)}
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
                            title={`Delete ${u.username}`} aria-label={`Delete ${u.username}`}
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
      <Pagination {...pager} noun="accounts" />

      {/* Add / Edit */}
      <Modal
        isOpen={!!modal}
        onClose={closeModal}
        title={modal?.mode === 'add' ? 'Add User Account' : `Edit: ${modal?.data?.username}`}
        onSubmit={handleSave}
        dirty={dirty}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={closeModal}>Cancel</button>
            <button className="btn btn-primary" disabled={saving}>
              {saving
                ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Saving…</>
                : <><IconCheck size={ICON_MD} /> {modal?.mode === 'add' ? 'Create' : 'Save Changes'}</>}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label>Username <span style={{ color: 'var(--danger)' }}>*</span></label>
          <input type="text" placeholder="e.g. warehouse_ops" autoComplete="off" {...field('username')} autoFocus />
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

        {/* Every account has the same access — there are no roles to assign. */}
        <p style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.6, margin: 0 }}>
          Accounts can view and manage every company, its stock, and its invoices.
        </p>

        {formErr && (
          <div className="login-error" style={{ marginTop: 12 }}>
            <IconAlert size={ICON_MD} /><span>{formErr}</span>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        isOpen={!!confirm}
        title="Delete Account"
        message={<>Delete the account <strong>{confirm?.username}</strong>? They will lose access immediately. This cannot be undone.</>}
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
