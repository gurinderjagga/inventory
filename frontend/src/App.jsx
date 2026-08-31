import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { AuthProvider, useAuth } from "./contexts/AuthContext.jsx";
import { ToastProvider } from "./contexts/ToastContext.jsx";
import Layout from "./components/Layout.jsx";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Companies from "./pages/Companies.jsx";
import Stock from "./pages/Stock.jsx";
import StockTransactions from "./pages/StockTransactions.jsx";
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
    <MotionConfig reducedMotion="user">
      <AuthProvider>
        <ToastProvider>
          <Routes>
            <Route path="/login" element={<Login />} />

            <Route element={<ProtectedLayout />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/companies" element={<Companies />} />
              <Route path="/stock" element={<Stock />} />
              <Route path="/transactions" element={<StockTransactions />} />
              <Route path="/users" element={<Users />} />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ToastProvider>
      </AuthProvider>
    </MotionConfig>
  );
}
