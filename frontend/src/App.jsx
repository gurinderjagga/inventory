import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { AuthProvider, useAuth } from "./contexts/AuthContext.jsx";
import { ToastProvider } from "./contexts/ToastContext.jsx";
import Layout from "./components/Layout.jsx";

// Pages are code-split with React.lazy so each route's JS is only downloaded
// when the user first navigates there.
//
// Each entry also exports a `preload` function so Layout can start fetching a
// chunk the moment the user hovers over the nav link — by the time they click,
// the download is usually complete and there is no loading flash at all.
const Login             = lazy(() => import('./pages/Login.jsx'));
const Dashboard         = lazy(() => import('./pages/Dashboard.jsx'));
const Companies         = lazy(() => import('./pages/Companies.jsx'));
const Stock             = lazy(() => import('./pages/Stock.jsx'));
const StockTransactions = lazy(() => import('./pages/StockTransactions.jsx'));
const Users             = lazy(() => import('./pages/Users.jsx'));
const Invoices          = lazy(() => import('./pages/Invoices.jsx'));

// Preload starters — called on nav hover/focus so the chunk fetch begins
// before the click event. Returns the same dynamic-import promise every time
// the browser deduplicates concurrent fetches for the same URL.
export const preloadPage = {
  '/':             () => import('./pages/Dashboard.jsx'),
  '/companies':    () => import('./pages/Companies.jsx'),
  '/stock':        () => import('./pages/Stock.jsx'),
  '/transactions': () => import('./pages/StockTransactions.jsx'),
  '/users':        () => import('./pages/Users.jsx'),
  '/invoices':     () => import('./pages/Invoices.jsx'),
};

function LoadingPage() {
  return (
    <div className="loading-page" style={{ height: "100vh" }}>
      <div className="spinner" />
      <span>Loading…</span>
    </div>
  );
}

// Wraps authenticated routes — redirects to /login if no session.
// Does NOT wrap in Suspense — Layout handles that so the sidebar stays visible.
function ProtectedLayout() {
  const { user, loading } = useAuth();
  const location          = useLocation();

  if (loading) return <LoadingPage />;
  if (!user) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  }
  return <Layout />;
}

// Wraps a route that only an admin may reach. Placed inside ProtectedLayout,
// so a signed-in sub-admin who navigates here directly (not just via a hidden
// nav link) is bounced to the dashboard rather than hitting a 403 from the API.
function AdminRoute({ children }) {
  const { user } = useAuth();
  if (user?.role !== 'admin') return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <AuthProvider>
        <ToastProvider>
          <Routes>
            {/* Login has its own Suspense — it is outside the Layout shell. */}
            <Route path="/login" element={
              <Suspense fallback={<LoadingPage />}>
                <Login />
              </Suspense>
            } />

            {/* Protected routes — Suspense lives inside Layout so the sidebar
                stays on screen while a lazy chunk is downloading. */}
            <Route element={<ProtectedLayout />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/companies" element={<Companies />} />
              <Route path="/stock" element={<Stock />} />
              <Route path="/transactions" element={<StockTransactions />} />
              <Route path="/invoices" element={<Invoices />} />
              <Route path="/users" element={<AdminRoute><Users /></AdminRoute>} />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ToastProvider>
      </AuthProvider>
    </MotionConfig>
  );
}
