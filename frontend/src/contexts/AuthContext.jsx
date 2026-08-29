import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);

  // Check existing session on mount
  useEffect(() => {
    api.me()
      .then(u => setUser(u))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  // Listen for session expiry from API client
  useEffect(() => {
    const handler = () => setUser(null);
    window.addEventListener('auth:expired', handler);
    return () => window.removeEventListener('auth:expired', handler);
  }, []);

  const login = useCallback(async (username, password) => {
    const data = await api.login(username, password);
    // Keep the same shape /me returns, so role and tenant are available
    // whether the session came from a fresh login or a page reload.
    setUser({
      id:           data.id,
      username:     data.username,
      role:         data.role,
      company_id:   data.company_id,
      company_name: data.company_name,
    });
    return data;
  }, []);

  const logout = useCallback(async () => {
    await api.logout().catch(() => {});
    setUser(null);
  }, []);

  // Stable so consumers can depend on it without re-running effects.
  const value = useMemo(() => ({
    user,
    loading,
    login,
    logout,
    // Convenience flag — the server is still the authority on every request;
    // this only decides what the UI bothers to show.
    isAdmin: user?.role === 'admin',
  }), [user, loading, login, logout]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
