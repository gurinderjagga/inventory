import { useState } from 'react';
import Modal from './Modal.jsx';
import { api, isAuthError } from '../api.js';
import { useToast } from '../contexts/ToastContext.jsx';

const EMPTY = { current: '', next: '', confirm: '' };

/** Lets the signed-in user change their own password. Props: isOpen, onClose */
export default function ChangePasswordModal({ isOpen, onClose }) {
  const { toast } = useToast();
  const [form, setForm]     = useState(EMPTY);
  const [err, setErr]       = useState('');
  const [saving, setSaving] = useState(false);

  const close = () => { setForm(EMPTY); setErr(''); setSaving(false); onClose(); };

  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm(f => ({ ...f, [key]: e.target.value })),
  });

  const handleSave = async () => {
    setErr('');
    if (!form.current)                 return setErr('Enter your current password.');
    if (form.next.length < 8)          return setErr('New password must be at least 8 characters.');
    if (form.next !== form.confirm)    return setErr('The two new passwords do not match.');
    if (form.next === form.current)    return setErr('The new password must be different from the current one.');

    setSaving(true);
    try {
      await api.changePassword(form.current, form.next);
      toast.success('Password changed.');
      close();
    } catch (e) {
      if (!isAuthError(e)) setErr(e.message);
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title="Change Password"
      footer={
        <>
          <button className="btn btn-secondary" onClick={close}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving
              ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Saving…</>
              : <><i className="bi bi-check-lg" /> Change Password</>}
          </button>
        </>
      }
    >
      <div className="form-group">
        <label>Current Password <span style={{ color: 'var(--danger)' }}>*</span></label>
        <input type="password" autoComplete="current-password" {...field('current')} autoFocus />
      </div>
      <div className="form-group">
        <label>New Password <span style={{ color: 'var(--danger)' }}>*</span></label>
        <input type="password" autoComplete="new-password" {...field('next')} />
        <small style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4, display: 'block' }}>
          At least 8 characters.
        </small>
      </div>
      <div className="form-group">
        <label>Confirm New Password <span style={{ color: 'var(--danger)' }}>*</span></label>
        <input type="password" autoComplete="new-password" {...field('confirm')} />
      </div>
      {err && (
        <div className="login-error">
          <i className="bi bi-exclamation-circle" /><span>{err}</span>
        </div>
      )}
    </Modal>
  );
}
