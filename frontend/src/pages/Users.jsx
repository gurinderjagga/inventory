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
import { IconAlert, IconCheck, IconCompany, IconDelete, IconEdit, IconSearch, IconShield, IconUser, IconUserPlus, IconUsers, ICON_MD } from '../lib/icons.jsx';

// New accounts default to sub_admin: an admin already has unscoped access by
// definition, so the common reason to add someone here is to hand them a
// scoped set of companies, not to mint another admin.
const EMPTY_FORM = { username: '', password: '', role: 'sub_admin' };

const SORT_COLUMNS = {
  username:   r => r.username,
  created_at: r => new Date(r.created_at).getTime(),
};

// ── Skeleton ──────────────────────────────────────────────────────────────────

function TableSkeleton() {
  return (
    <div className="skeleton-table" style={{ marginTop: 16 }}>
      <div className="skeleton-thead">
        {[1, 2, 3, 4].map(i => <div key={i} className="skeleton-bar" />)}
      </div>
      {[1, 2, 3, 4].map(i => (
        <div key={i} className="skeleton-row" style={{ opacity: 1 - i * 0.12 }}>
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

  // Company-assignment modal for a sub-admin, opened from its row.
  const [companyModal, setCompanyModal]     = useState(null); // null | user row
  const [allCompanies, setAllCompanies]     = useState([]);
  const [assignedIds, setAssignedIds]       = useState(new Set());
  const [companiesLoading, setCompaniesLoading] = useState(false);
  const [togglingId, setTogglingId]         = useState(null);

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
    const next = { username: u.username, password: '', role: u.role };
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

  /* ── Save (optimistic) ──────────────────────────────── */
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

    const payload = { username: form.username.trim(), role: form.role };
    if (form.password) payload.password = form.password;

    setSaving(true);
    try {
      if (modal.mode === 'add') {
        const created = await api.createUser(payload);
        setUsers(prev => [...prev, created]);
        toast.success('Account created.');
      } else {
        const updated = await api.updateUser(modal.data.id, payload);
        setUsers(prev => prev.map(u => u.id === modal.data.id ? { ...u, ...updated } : u));
        toast.success('Account updated.');
      }
      closeModal();
    } catch (e) {
      if (!isAuthError(e)) setFormErr(e.message);
      setSaving(false);
    }
  };

  /* ── Delete (optimistic) ────────────────────────────── */
  const handleDelete = async () => {
    if (!confirm || deleting) return;
    const { id, username } = confirm;
    setDeleting(true);
    const snapshot = users;
    setUsers(prev => prev.filter(u => u.id !== id));
    setConfirm(null);
    try {
      await api.deleteUser(id);
      toast.success(`"${username}" deleted.`);
    } catch (e) {
      setUsers(snapshot);
      if (!isAuthError(e)) toast.error(e.message, 'Could not delete account');
    } finally {
      setDeleting(false);
    }
  };

  /* ── Company assignment (sub-admins only) ────────────── */
  const openCompanies = async (u) => {
    setCompanyModal(u);
    setCompaniesLoading(true);
    try {
      const [companies, assigned] = await Promise.all([
        api.getCompanies(),
        api.getUserCompanies(u.id),
      ]);
      setAllCompanies(companies);
      setAssignedIds(new Set(assigned.map(c => c.id)));
    } catch (e) {
      if (!isAuthError(e)) toast.error(e.message);
      setCompanyModal(null);
    } finally {
      setCompaniesLoading(false);
    }
  };

  const closeCompanies = () => setCompanyModal(null);

  const toggleCompany = async (companyId, currentlyAssigned) => {
    if (togglingId) return; // one in-flight toggle at a time keeps this simple
    setTogglingId(companyId);
    try {
      if (currentlyAssigned) {
        await api.unassignUserCompany(companyModal.id, companyId);
        setAssignedIds(prev => {
          const next = new Set(prev);
          next.delete(companyId);
          return next;
        });
      } else {
        await api.assignUserCompany(companyModal.id, companyId);
        setAssignedIds(prev => new Set(prev).add(companyId));
      }
    } catch (e) {
      if (!isAuthError(e)) toast.error(e.message, 'Could not update company access');
    } finally {
      setTogglingId(null);
    }
  };

  /* ── Render ─────────────────────────────────────────── */
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

      {/* Skeleton while loading */}
      {loading && <TableSkeleton />}

      {!loading && (
        filtered.length === 0 ? (
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
                  <th>Role</th>
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
                      <td>
                        {u.role === 'admin'
                          ? <span className="badge badge-success"><IconShield size={ICON_MD} /> Admin</span>
                          : <span className="badge badge-neutral"><IconUser size={ICON_MD} /> Sub-admin</span>}
                      </td>
                      <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>
                        {formatDate(u.created_at)}
                      </td>
                      <td>
                        <div className="td-actions">
                          {u.role === 'sub_admin' && (
                            <button className="btn btn-secondary btn-sm" onClick={() => openCompanies(u)}>
                              <IconCompany size={ICON_MD} /> Companies
                            </button>
                          )}
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
        )
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

        <div className="form-group">
          <label>Access Level</label>
          <select {...field('role')}>
            <option value="sub_admin">Sub-admin — only assigned companies</option>
            <option value="admin">Admin — every company</option>
          </select>
          <small style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4, display: 'block' }}>
            {form.role === 'admin'
              ? 'Can see and manage every company, and manage other accounts.'
              : 'Can only see and manage companies you assign it, from the "Companies" button on its row.'}
          </small>
        </div>

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

      {/* Company assignment — which companies a sub-admin can see and manage */}
      <Modal
        isOpen={!!companyModal}
        onClose={closeCompanies}
        title={`Companies: ${companyModal?.username || ''}`}
        footer={<button type="button" className="btn btn-primary" onClick={closeCompanies}>Done</button>}
      >
        {companiesLoading ? (
          <div className="skeleton-table">
            {[1, 2, 3].map(i => (
              <div key={i} className="skeleton-row" style={{ opacity: 1 - i * 0.15 }}>
                <div className="skeleton-bar" />
              </div>
            ))}
          </div>
        ) : allCompanies.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
            No companies exist yet — add one from the Companies page first.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
            {allCompanies.map(c => {
              const isAssigned = assignedIds.has(c.id);
              return (
                <label
                  key={c.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                    borderRadius: 8, cursor: togglingId ? 'wait' : 'pointer',
                    background: isAssigned ? 'var(--surface-hover, rgba(127,127,127,0.08))' : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isAssigned}
                    disabled={togglingId === c.id}
                    onChange={() => toggleCompany(c.id, isAssigned)}
                  />
                  <IconCompany size={ICON_MD} />
                  <span style={{ fontSize: 13.5 }}>{c.name}</span>
                </label>
              );
            })}
          </div>
        )}
      </Modal>
    </div>
  );
}
