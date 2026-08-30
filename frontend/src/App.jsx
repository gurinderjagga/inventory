import { Routes, Route, Navigate } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { AuthProvider, useAuth } from "./contexts/AuthContext.jsx";
import { ToastProvider } from "./contexts/ToastContext.jsx";
import Layout from "./components/Layout.jsx";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Companies from "./pages/Companies.jsx";
import Stock from "./pages/Stock.jsx";
import Invoices from "./pages/Invoices.jsx";
import Users from "./pages/Users.jsx";

function LoadingPage() {
  return (
    <div className="loading-page" style={{ height: "100vh" }}>
      <div className="spinner" />
      <span>Loading…</span>
    </div>
  );
}

// Wraps authenticated routes — redirects to /login if no session
function ProtectedLayout() {
  const { user, loading } = useAuth();

  if (loading) return <LoadingPage />;
  if (!user) return <Navigate to="/login" replace />;
  return <Layout />;
}

/**
 * Gate for platform-admin-only pages.
 *
 * This hides a page a company admin has no use for; it is not the security
 * boundary. The API independently refuses these calls, so bypassing the router
 * gains nothing.
 */
function AdminOnly({ children }) {
  const { loading, isAdmin } = useAuth();

  if (loading) return <LoadingPage />;
  if (!isAdmin) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    // reducedMotion="user" makes every Framer animation collapse to an instant
    // state change when the OS asks for reduced motion — the CSS media query
    // alone cannot reach JS-driven animation.
    <MotionConfig reducedMotion="user">
      <AuthProvider>
        <ToastProvider>
        <Routes>
          <Route path="/login" element={<Login />} />

          {/* All authenticated pages rendered inside the Layout shell */}
          <Route element={<ProtectedLayout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/companies" element={<Companies />} />
            <Route path="/stock" element={<Stock />} />
            <Route path="/invoices" element={<Invoices />} />
            <Route
              path="/users"
              element={
                <AdminOnly>
                  <Users />
                </AdminOnly>
              }
            />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </ToastProvider>
      </AuthProvider>
    </MotionConfig>
  );
}
