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
 * Props: isOpen, title, message (ReactNode), confirmText, danger, onConfirm, onCancel
 */
export default function ConfirmDialog({
  isOpen,
  title = 'Confirm',
  message,
  confirmText = 'Confirm',
  danger = false,
  onConfirm,
  onCancel,
}) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
          >
            {confirmText}
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
