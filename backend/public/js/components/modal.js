/** Reusable Modal component */

let activeModal = null;

export function openModal({ title, body, footer, size = '', onClose }) {
  closeModal(); // close any existing modal

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="modal-header">
        <h3 class="modal-title">${title}</h3>
        <button class="modal-close" id="modal-close-btn" aria-label="Close">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
    </div>
  `;

  document.getElementById('modal-root').appendChild(backdrop);
  activeModal = backdrop;

  // Close events
  backdrop.querySelector('#modal-close-btn').addEventListener('click', () => {
    closeModal();
    onClose?.();
  });

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      closeModal();
      onClose?.();
    }
  });

  document.addEventListener('keydown', handleEsc);

  // Return the modal element for event binding
  return backdrop.querySelector('.modal');
}

export function closeModal() {
  if (!activeModal) return;
  activeModal.remove();
  activeModal = null;
  document.removeEventListener('keydown', handleEsc);
}

function handleEsc(e) {
  if (e.key === 'Escape') closeModal();
}

/**
 * Confirmation dialog
 * Returns a Promise<boolean>
 */
export function confirm({ title = 'Confirm', message, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const modal = openModal({
      title,
      body: `<p style="color:var(--text-secondary);font-size:14px;line-height:1.6">${message}</p>`,
      footer: `
        <button class="btn btn-secondary" id="confirm-cancel">Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="confirm-ok">${confirmText}</button>
      `,
      onClose: () => resolve(false),
    });

    modal.querySelector('#confirm-cancel').addEventListener('click', () => {
      closeModal();
      resolve(false);
    });

    modal.querySelector('#confirm-ok').addEventListener('click', () => {
      closeModal();
      resolve(true);
    });
  });
}
