/** Toast notification system */

const icons = {
  success: 'bi-check-circle-fill',
  error:   'bi-x-circle-fill',
  warning: 'bi-exclamation-triangle-fill',
  info:    'bi-info-circle-fill',
};

const titles = {
  success: 'Success',
  error:   'Error',
  warning: 'Warning',
  info:    'Info',
};

export function showToast(type = 'info', message, customTitle) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <i class="bi ${icons[type]} toast-icon"></i>
    <div class="toast-content">
      <div class="toast-title">${customTitle || titles[type]}</div>
      <div class="toast-msg">${message}</div>
    </div>
  `;

  container.appendChild(toast);

  // Auto-remove after 4 seconds
  const timer = setTimeout(() => removeToast(toast), 4000);

  toast.addEventListener('click', () => {
    clearTimeout(timer);
    removeToast(toast);
  });
}

function removeToast(toast) {
  toast.classList.add('leaving');
  toast.addEventListener('animationend', () => toast.remove(), { once: true });
}

// Convenience shortcuts
export const toast = {
  success: (msg, title)  => showToast('success', msg, title),
  error:   (msg, title)  => showToast('error',   msg, title),
  warning: (msg, title)  => showToast('warning', msg, title),
  info:    (msg, title)  => showToast('info',    msg, title),
};
