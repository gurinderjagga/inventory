/** Sidebar navigation component */

import { api } from '../api.js';
import { toast } from './toast.js';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard',  icon: 'bi-grid-1x2-fill',     section: 'MAIN' },
  { id: 'companies', label: 'Companies',  icon: 'bi-building-fill',      section: 'MAIN' },
  { id: 'stock',     label: 'Stock',      icon: 'bi-box-seam-fill',      section: 'MAIN' },
  { id: 'invoices',  label: 'Invoices',   icon: 'bi-receipt-cutoff',     section: 'MAIN' },
];

export function renderSidebar(currentPage, username, onNavigate) {
  const el = document.getElementById('sidebar');

  // Group items by section
  const sections = {};
  for (const item of NAV_ITEMS) {
    if (!sections[item.section]) sections[item.section] = [];
    sections[item.section].push(item);
  }

  const navHTML = Object.entries(sections).map(([section, items]) => `
    <div class="nav-section-label">${section}</div>
    ${items.map(item => `
      <div class="nav-item ${currentPage === item.id ? 'active' : ''}"
           data-page="${item.id}"
           role="button"
           tabindex="0"
           aria-current="${currentPage === item.id ? 'page' : 'false'}">
        <i class="bi ${item.icon}"></i>
        <span>${item.label}</span>
      </div>
    `).join('')}
  `).join('');

  const initial = username ? username[0].toUpperCase() : 'A';

  el.innerHTML = `
    <div class="sidebar-brand">
      <div class="brand-logo">
        <div class="brand-icon">📦</div>
        <div>
          <div class="brand-text">StockFlow</div>
          <div class="brand-sub">Inventory & Invoicing</div>
        </div>
      </div>
    </div>
    <nav class="sidebar-nav" role="navigation">${navHTML}</nav>
    <div class="sidebar-footer">
      <div class="user-card">
        <div class="user-avatar">${initial}</div>
        <div class="user-info">
          <div class="user-name">${username || 'Admin'}</div>
          <div class="user-role">Administrator</div>
        </div>
        <button class="btn-logout" id="logout-btn" title="Sign Out" aria-label="Sign out">
          <i class="bi bi-box-arrow-right"></i>
        </button>
      </div>
    </div>
  `;

  // Navigation click events
  el.querySelectorAll('.nav-item').forEach(item => {
    const navigate = () => onNavigate(item.dataset.page);
    item.addEventListener('click', navigate);
    item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') navigate(); });
  });

  // Logout
  el.querySelector('#logout-btn').addEventListener('click', async () => {
    try {
      await api.logout();
    } catch (_) { /* ignore */ }
    window.location.reload();
  });
}

export function updateSidebarActive(page) {
  document.querySelectorAll('.nav-item').forEach(el => {
    const isActive = el.dataset.page === page;
    el.classList.toggle('active', isActive);
    el.setAttribute('aria-current', isActive ? 'page' : 'false');
  });
}
