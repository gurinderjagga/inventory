import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api, isAuthError } from '../api.js';
import { listContainer, listItem, hoverLift } from '../lib/motion.js';
import { useToast } from '../contexts/ToastContext.jsx';
import Modal from '../components/Modal.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Pagination, { usePagination } from '../components/Pagination.jsx';
import { useTableSort, SortableTh } from '../lib/useTableSort.jsx';
import {
  IconAlert, IconBack, IconCheck, IconChevron, IconCompany, IconDelete, IconEdit,
  IconPlus, IconSearch, IconCustomer, IconArchive, IconRestore, ICON_MD,
} from '../lib/icons.jsx';

const EMPTY_FORM = { name: '', address: '', gstin: '', state_code: '' };

const SORT_COLUMNS = {
  name:       r => r.name,
  gstin:      r => r.gstin || '',
  state_code: r => r.state_code || '',
  status:     r => (r.active === false ? 0 : 1),
};

export default function Customers() {
  const { toast } = useToast();
  const [companies, setCompanies] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [search, setSearch]       = useState('');
  const [loadingComp, setLoadingComp] = useState(true);
  const [loadingCust, setLoadingCust] = useState(false);
  const [modal, setModal]         = useState(null);
  const [form, setForm]           = useState(EMPTY_FORM);
  const [formErr, setFormErr]     = useState('');
  const [saving, setSaving]       = useState(false);
  const [confirm, setConfirm]     = useState(null);
  const [deleting, setDeleting]   = useState(false);
  const [pristine, setPristine]   = useState('');

  // Which company's customers are on screen lives in the URL, same pattern as
  // Stock.jsx — a customer belongs to one company, so there is always a
  // company picker in front of the list.
  const [params, setParams] = useSearchParams();
  const companyParam        = params.get('company');

  const dirty = !!modal && JSON.stringify(form) !== pristine;

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
    if (!selectedId) { setCustomers([]); return; }
    let cancelled = false;
    setLoadingCust(true);
    api.getCustomers(selectedId)
      .then(data => { if (!cancelled) setCustomers(data); })
      .catch(e => { if (!cancelled && !isAuthError(e)) toast.error(e.message); })
      .finally(() => { if (!cancelled) setLoadingCust(false); });
    return () => { cancelled = true; };
  }, [selectedId, refreshKey, toast]);

  const selectCompany = (company) => {
    setSearch('');
    setParams({ company: String(company.id) });
  };

  const goBack = () => { setSearch(''); setParams({}); };

  /* ── Modal ──────────────────────────────────────────── */
  const openAdd = () => {
    setForm(EMPTY_FORM);
    setPristine(JSON.stringify(EMPTY_FORM));
    setFormErr('');
    setModal({ mode: 'add', data: null });
  };

  const openEdit = (customer) => {
    const next = {
      name: customer.name, address: customer.address || '',
      gstin: customer.gstin || '', state_code: customer.state_code || '',
    };
    setForm(next);
    setPristine(JSON.stringify(next));
    setFormErr('');
    setModal({ mode: 'edit', data: customer });
  };

  const closeModal = () => { setModal(null); setSaving(false); };

  const handleSave = async () => {
    if (!form.name.trim()) { setFormErr('Customer name is required.'); return; }
    setSaving(true); setFormErr('');
    const payload = {
      name: form.name.trim(), address: form.address.trim() || null,
      gstin: form.gstin.trim() || null, state_code: form.state_code.trim() || null,
    };
    try {
      if (modal.mode === 'add') {
        await api.createCustomer({ ...payload, company_id: selected.id });
        toast.success('Customer added.');
      } else {
        await api.updateCustomer(modal.data.id, payload);
        toast.success('Customer updated.');
      }
      closeModal();
      setRefreshKey(k => k + 1);
    } catch (e) { setFormErr(e.message); setSaving(false); }
  };

  const toggleActive = async (customer) => {
    try {
      await api.updateCustomer(customer.id, {
        name: customer.name, address: customer.address, gstin: customer.gstin,
        state_code: customer.state_code, active: !customer.active,
      });
      toast.success(customer.active === false ? `"${customer.name}" reactivated.` : `"${customer.name}" archived.`);
      setRefreshKey(k => k + 1);
    } catch (e) { if (!isAuthError(e)) toast.error(e.message); }
  };

  const handleDelete = async () => {
    if (!confirm || deleting) return;
    const { id, name } = confirm;
    setDeleting(true);
    try {
      await api.deleteCustomer(id);
      toast.success(`"${name}" removed.`);
      setRefreshKey(k => k + 1);
    } catch (e) {
      if (!isAuthError(e)) toast.error(e.message, 'Could not delete customer');
    } finally {
      setDeleting(false);
      setConfirm(null);
    }
  };

  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm(f => ({ ...f, [key]: e.target.value })),
  });

  const filtered = customers.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.gstin || '').toLowerCase().includes(search.toLowerCase())
  );
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
            <p>Click a company to view and manage its customers</p>
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

  /* ── Customers table ──────────────────────────────── */
  return (
    <div className="page-enter">
      <div className="breadcrumb">
        <button type="button" onClick={goBack} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, padding: 0 }}>
          Customers
        </button>
        <IconChevron size={ICON_MD} style={{ fontSize: 10 }} />
        <span className="current">{selected.name}</span>
      </div>

      <div className="page-header">
        <div className="page-header-text">
          <h2>{selected.name}</h2>
          <p>
            {search
              ? `${filtered.length} of ${customers.length} customer${customers.length !== 1 ? 's' : ''} shown`
              : `${customers.length} customer${customers.length !== 1 ? 's' : ''} on record`}
          </p>
        </div>
        <div className="flex gap-2 items-center" style={{ flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={goBack}>
            <IconBack size={ICON_MD} /> All Companies
          </button>
          <div className="search-wrap">
            <IconSearch size={ICON_MD} />
            <input placeholder="Search customers…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={openAdd}>
            <IconPlus size={ICON_MD} /> Add Customer
          </button>
        </div>
      </div>

      {loadingCust ? (
        <div className="loading-page"><div className="spinner" /></div>
      ) : filtered.length === 0 ? (
        <EmptyState
          Icon={IconCustomer}
          query={search}
          onClear={() => setSearch('')}
          noun="customers"
          title="No customers yet"
          hint="Add your first customer using the button above."
        />
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <SortableTh sortKey="name"       sort={sort} onToggle={toggle}>Customer Name</SortableTh>
                <SortableTh sortKey="gstin"      sort={sort} onToggle={toggle}>GSTIN</SortableTh>
                <SortableTh sortKey="state_code" sort={sort} onToggle={toggle}>State Code</SortableTh>
                <SortableTh sortKey="status"     sort={sort} onToggle={toggle}>Status</SortableTh>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <motion.tbody variants={listContainer} initial="initial" animate="animate">
              {pager.visible.map(c => (
                <motion.tr key={c.id} variants={listItem}>
                  <td className="cell-primary">{c.name}</td>
                  <td className="code">{c.gstin || '—'}</td>
                  <td className="cell-muted">{c.state_code || '—'}</td>
                  <td>
                    {c.active === false
                      ? <span className="badge badge-neutral">Archived</span>
                      : <span className="badge badge-success">Active</span>}
                  </td>
                  <td>
                    <div className="td-actions">
                      <button className="btn btn-secondary btn-sm" onClick={() => openEdit(c)}>
                        <IconEdit size={ICON_MD} /> Edit
                      </button>
                      <button className="btn btn-secondary btn-sm" onClick={() => toggleActive(c)}
                              title={c.active === false ? `Reactivate ${c.name}` : `Archive ${c.name}`}
                              aria-label={c.active === false ? `Reactivate ${c.name}` : `Archive ${c.name}`}>
                        {c.active === false ? <IconRestore size={ICON_MD} /> : <IconArchive size={ICON_MD} />}
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
      )}
      <Pagination {...pager} noun="customers" />

      <Modal isOpen={!!modal} onClose={closeModal}
        title={modal?.mode === 'add' ? 'Add Customer' : `Edit: ${modal?.data?.name}`}
        onSubmit={handleSave}
        dirty={dirty}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={closeModal}>Cancel</button>
            <button className="btn btn-primary" disabled={saving}>
              {saving ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Saving…</> : <><IconCheck size={ICON_MD} /> {modal?.mode === 'add' ? 'Add Customer' : 'Save Changes'}</>}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label>Customer Name <span style={{ color: 'var(--danger)' }}>*</span></label>
          <input type="text" placeholder="e.g. Riya Sharma" {...field('name')} autoFocus />
        </div>
        <div className="form-group">
          <label>Address</label>
          <textarea placeholder="Street, City, State" {...field('address')} />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>GSTIN (optional)</label>
            <input type="text" placeholder="e.g. 27ABCDE1234F1Z5" maxLength={15} {...field('gstin')} />
            <small className="field-hint">Only needed for a registered business customer (B2B)</small>
          </div>
          <div className="form-group">
            <label>State Code (optional)</label>
            <input type="text" placeholder="e.g. 27" maxLength={2} {...field('state_code')} />
          </div>
        </div>
        {formErr && <div className="login-error"><IconAlert size={ICON_MD} /><span>{formErr}</span></div>}
      </Modal>

      <ConfirmDialog isOpen={!!confirm} title="Delete Customer"
        message={<>Remove <strong>{confirm?.name}</strong> from {selected.name}&rsquo;s customer list? Customers billed on an invoice cannot be deleted — archive instead.</>}
        confirmText="Delete" busyText="Deleting…" danger busy={deleting}
        onConfirm={handleDelete} onCancel={() => setConfirm(null)} />
    </div>
  );
}
