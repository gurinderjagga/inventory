import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext.jsx';
import { ToastProvider } from './contexts/ToastContext.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Companies from './pages/Companies.jsx';
import Stock from './pages/Stock.jsx';
import Invoices from './pages/Invoices.jsx';

// Wraps authenticated routes — redirects to /login if no session
function ProtectedLayout() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="loading-page" style={{ height: '100vh' }}>
        <div className="spinner" />
        <span>Loading…</span>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  return <Layout />;
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <Routes>
          <Route path="/login" element={<Login />} />

          {/* All authenticated pages rendered inside the Layout shell */}
          <Route element={<ProtectedLayout />}>
            <Route path="/"          element={<Dashboard />} />
            <Route path="/companies" element={<Companies />} />
            <Route path="/stock"     element={<Stock />} />
            <Route path="/invoices"  element={<Invoices />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ToastProvider>
    </AuthProvider>
  );
}
