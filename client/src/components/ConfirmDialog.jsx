import Modal from './Modal.jsx';

/**
 * Confirm dialog modal.
 * Props: isOpen, title, message (HTML string), confirmText, danger, onConfirm, onCancel
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
      <p
        style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.7 }}
        dangerouslySetInnerHTML={{ __html: message }}
      />
    </Modal>
  );
}
