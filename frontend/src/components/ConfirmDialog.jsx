import Modal from './Modal.jsx';

/**
 * Confirm dialog modal.
 *
 * `message` is a React node, not an HTML string. It used to be injected with
 * dangerouslySetInnerHTML while callers interpolated company and item names
 * straight into it, so a record named `<img src=x onerror=…>` would execute
 * its payload the moment someone opened the delete dialog. Rendering the node
 * as children lets React escape the text and keeps the markup callers actually
 * intend (e.g. <strong>) working.
 *
 * `busy` keeps the dialog up while the request is in flight. Closing first and
 * reporting afterwards left a gap where the row was still on screen, nothing
 * was moving, and the obvious response was to click Delete again.
 *
 * Props: isOpen, title, message (ReactNode), confirmText, busyText, danger,
 *        busy, onConfirm, onCancel
 */
export default function ConfirmDialog({
  isOpen,
  title = 'Confirm',
  message,
  confirmText = 'Confirm',
  busyText = 'Working…',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}) {
  return (
    <Modal
      isOpen={isOpen}
      // A request in flight must not be dismissed out from under itself.
      onClose={busy ? () => {} : onCancel}
      title={title}
      // Always a form, even while busy — swapping the wrapper mid-request
      // would remount the buttons and drop focus. Re-entry is stopped by the
      // disabled button and the caller's own in-flight guard.
      onSubmit={onConfirm}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            disabled={busy}
          >
            {busy
              ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> {busyText}</>
              : confirmText}
          </button>
        </>
      }
    >
      <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.7 }}>
        {message}
      </p>
    </Modal>
  );
}
