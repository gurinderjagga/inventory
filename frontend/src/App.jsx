import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { AuthProvider, useAuth } from "./contexts/AuthContext.jsx";
import { ToastProvider } from "./contexts/ToastContext.jsx";
import Layout from "./components/Layout.jsx";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Companies from "./pages/Companies.jsx";
import Stock from "./pages/Stock.jsx";
import Customers from "./pages/Customers.jsx";
import GoodsReceipts from "./pages/GoodsReceipts.jsx";
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
  const location          = useLocation();

  if (loading) return <LoadingPage />;
  // Remember where they were headed. A session that expires mid-task used to
  // drop the user on the Dashboard after signing back in, with no hint that
  // they had been somewhere else.
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
            <Route path="/customers" element={<Customers />} />
            <Route path="/goods-receipts" element={<GoodsReceipts />} />
            <Route path="/invoices" element={<Invoices />} />
            <Route path="/users" element={<Users />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </ToastProvider>
      </AuthProvider>
    </MotionConfig>
  );
}
