import { useState } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import ChangePasswordModal from './ChangePasswordModal.jsx';

// `adminOnly` items are hidden from company admins. This is presentation only —
// the API refuses them regardless of what the sidebar shows.
const NAV = [
  { to: '/',          label: 'Dashboard', icon: 'bi-grid-1x2-fill', exact: true },
  { to: '/companies', label: 'Companies', icon: 'bi-building-fill', tenantLabel: 'My Company' },
  { to: '/stock',     label: 'Stock',     icon: 'bi-box-seam-fill' },
  { to: '/invoices',  label: 'Invoices',  icon: 'bi-receipt-cutoff' },
  { to: '/users',     label: 'Users',     icon: 'bi-people-fill', adminOnly: true },
];

const PAGE_TITLES = {
  '/':          'Dashboard',
  '/companies': 'Companies',
  '/stock':     'Stock Management',
  '/invoices':  'Invoices',
  '/users':     'User Accounts',
};

export default function Layout() {
  const { user, logout, isAdmin } = useAuth();
  const navigate                  = useNavigate();
  const location                  = useLocation();
  const [pwOpen, setPwOpen]       = useState(false);

  const pageTitle = PAGE_TITLES[location.pathname] || 'StockFlow';
  const initial   = user?.username?.[0]?.toUpperCase() ?? 'A';

  const items = NAV.filter(item => isAdmin || !item.adminOnly);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="shell">
      {/* ── Sidebar ─────────────────────────────────────── */}
      <aside className="sidebar">
        {/* Brand */}
        <div className="sidebar-brand">
          <div className="brand-logo">
            <div className="brand-icon">📦</div>
            <div>
              <div className="brand-text">StockFlow</div>
              {/* A company admin works inside one tenant, so name it here. */}
              <div className="brand-sub">{user?.company_name || 'Inventory & Invoicing'}</div>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="sidebar-nav" role="navigation">
          <div className="nav-section-label">Main</div>
          {items.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.exact}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <i className={`bi ${item.icon}`} />
              <span>{!isAdmin && item.tenantLabel ? item.tenantLabel : item.label}</span>
            </NavLink>
          ))}
        </nav>

        {/* User footer */}
        <div className="sidebar-footer">
          <div className="user-card">
            <div className="user-avatar">{initial}</div>
            <div className="user-info">
              <div className="user-name">{user?.username}</div>
              <div className="user-role">
                {isAdmin ? 'Platform Admin' : 'Company Admin'}
              </div>
            </div>
            <button className="btn-logout" onClick={() => setPwOpen(true)} title="Change Password">
              <i className="bi bi-key" />
            </button>
            <button className="btn-logout" onClick={handleLogout} title="Sign Out">
              <i className="bi bi-box-arrow-right" />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main wrapper ────────────────────────────────── */}
      <div className="main-wrapper">
        {/* Topbar */}
        <header className="topbar">
          <span className="topbar-title">{pageTitle}</span>
        </header>

        {/* Page content — React Router renders matched child here */}
        <main className="page-content">
          <Outlet />
        </main>
      </div>

      <ChangePasswordModal isOpen={pwOpen} onClose={() => setPwOpen(false)} />
    </div>
  );
}
