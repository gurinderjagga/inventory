import { useState, useEffect, useRef } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '../contexts/AuthContext.jsx';
import { pageVariants } from '../lib/motion.js';
import ChangePasswordModal from './ChangePasswordModal.jsx';
import {
  IconDashboard, IconCompany, IconStock, IconInvoice, IconUsers, IconCustomer, IconGoodsReceipt,
  IconBrand, IconLogout, IconKey, IconMenu, IconClose, ICON_MD, ICON_LG,
} from '../lib/icons.jsx';

const NAV = [
  { to: '/',              label: 'Dashboard',      Icon: IconDashboard, exact: true },
  { to: '/companies',     label: 'Companies',      Icon: IconCompany },
  { to: '/stock',         label: 'Stock',          Icon: IconStock },
  { to: '/customers',     label: 'Customers',      Icon: IconCustomer },
  { to: '/goods-receipts',label: 'Goods Receipts', Icon: IconGoodsReceipt },
  { to: '/invoices',      label: 'Invoices',       Icon: IconInvoice },
  { to: '/users',         label: 'Users',          Icon: IconUsers },
];

const PAGE_TITLES = {
  '/':               'Dashboard',
  '/companies':      'Companies',
  '/stock':          'Stock Management',
  '/customers':      'Customers',
  '/goods-receipts': 'Goods Receipts',
  '/invoices':       'Invoices',
  '/users':          'User Accounts',
};

export default function Layout() {
  const { user, logout }    = useAuth();
  const navigate            = useNavigate();
  const location            = useLocation();
  const [pwOpen, setPwOpen] = useState(false);

  // Below 640px the sidebar is a drawer. Without this the whole navigation —
  // every page, sign-out and change-password included — was simply unreachable
  // on a phone: the sidebar was translated off-screen with nothing to open it.
  const [navOpen, setNavOpen] = useState(false);
  const menuButtonRef         = useRef(null);
  const sidebarRef            = useRef(null);

  const pageTitle = PAGE_TITLES[location.pathname] || 'StockFlow';
  const initial   = user?.username?.[0]?.toUpperCase() ?? 'A';

  // Navigating is the whole point of the drawer, so close it on arrival.
  useEffect(() => { setNavOpen(false); }, [location.pathname]);

  // Every route shared one title, which made tabs and browser history
  // indistinguishable from one another.
  useEffect(() => { document.title = `${pageTitle} · StockFlow`; }, [pageTitle]);

  // Escape closes it, and focus goes back to the button that opened it rather
  // than being dropped at the top of the document.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setNavOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  // Move focus into the drawer when it opens, so a keyboard or screen-reader
  // user lands on the navigation instead of tabbing through the page behind it.
  useEffect(() => {
    if (navOpen) sidebarRef.current?.querySelector('a, button')?.focus();
  }, [navOpen]);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="shell">
      {/* Drawer scrim, and the tap-anywhere-to-close target.
          Deliberately CSS-driven rather than an AnimatePresence exit: a scrim
          whose removal depends on an animation finishing would swallow every
          tap on the page if that animation ever stalled. `visibility` in the
          transition guarantees it stops taking input the moment it closes. */}
      <div
        className={`nav-scrim${navOpen ? ' open' : ''}`}
        onClick={() => setNavOpen(false)}
        aria-hidden="true"
      />

      {/* ── Sidebar ─────────────────────────────────────── */}
      <aside
        id="app-sidebar"
        className={`sidebar${navOpen ? ' open' : ''}`}
        ref={sidebarRef}
      >
        {/* Brand */}
        <div className="sidebar-brand">
          <div className="brand-logo">
            <div className="brand-icon"><IconBrand size={ICON_LG} color="#fff" /></div>
            <div>
              <div className="brand-text">StockFlow</div>
              <div className="brand-sub">Inventory &amp; Invoicing</div>
            </div>
          </div>
          {/* Closes the drawer from inside it; hidden at desktop widths. */}
          <button
            className="sidebar-dismiss"
            onClick={() => { setNavOpen(false); menuButtonRef.current?.focus(); }}
            aria-label="Close navigation"
          >
            <IconClose size={ICON_MD} />
          </button>
        </div>

        {/* Navigation */}
        <nav className="sidebar-nav" role="navigation">
          <div className="nav-section-label">Main</div>
          {NAV.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.exact}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              {({ isActive }) => (
                <>
                  {/* A single shared element that slides between items rather
                      than fading in and out on each one. */}
                  {isActive && (
                    <motion.span
                      layoutId="nav-active"
                      style={{
                        position: 'absolute', inset: 0,
                        background: 'var(--accent-soft)',
                        borderRadius: 'var(--radius-sm)',
                        zIndex: 0,
                      }}
                      transition={{ type: 'spring', stiffness: 420, damping: 34, mass: 0.7 }}
                    />
                  )}
                  <item.Icon size={ICON_MD} style={{ position: 'relative', zIndex: 1, flexShrink: 0 }} />
                  <span style={{ position: 'relative', zIndex: 1 }}>{item.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* User footer */}
        <div className="sidebar-footer">
          <div className="user-card">
            <div className="user-avatar">{initial}</div>
            <div className="user-info">
              <div className="user-name">{user?.username}</div>
              <div className="user-role">Signed in</div>
            </div>
            <button type="button" className="user-action" onClick={() => setPwOpen(true)}
                    title="Change password" aria-label="Change password">
              <IconKey size={ICON_MD} />
            </button>
            <button type="button" className="user-action user-action-signout" onClick={handleLogout}
                    title="Sign out" aria-label="Sign out">
              <IconLogout size={ICON_MD} />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main wrapper ────────────────────────────────── */}
      <div className="main-wrapper">
        {/* Topbar */}
        <header className="topbar">
          <button
            className="topbar-menu"
            ref={menuButtonRef}
            onClick={() => setNavOpen(o => !o)}
            aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={navOpen}
            aria-controls="app-sidebar"
          >
            <IconMenu size={ICON_LG} />
          </button>
          <span className="topbar-title">{pageTitle}</span>
        </header>

        {/* Page content — React Router renders matched child here.
            Keyed on pathname so each route fades through cleanly; mode="wait"
            lets the outgoing page finish before the next one arrives, which
            avoids two pages briefly overlapping mid-scroll. */}
        <main className="page-content">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={location.pathname}
              variants={pageVariants}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      <ChangePasswordModal isOpen={pwOpen} onClose={() => setPwOpen(false)} />
    </div>
  );
}
