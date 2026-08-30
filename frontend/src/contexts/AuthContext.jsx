import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api } from '../api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);

  // True when a session ended underneath the user rather than never existing.
  // Being bounced to a blank login form with no explanation reads as a bug;
  // Login uses this to say what happened.
  const [sessionExpired, setSessionExpired] = useState(false);

  // Check existing session on mount
  useEffect(() => {
    api.me()
      .then(u => setUser(u))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  // Read inside the expiry handler, which is registered once and so cannot
  // close over the current `user`.
  const hadSession = useRef(false);
  useEffect(() => { hadSession.current = !!user; }, [user]);

  // Listen for session expiry from API client
  useEffect(() => {
    const handler = () => {
      // Only an *interrupted* session is worth explaining. A 401 from the
      // mount-time /me check on a machine that was never signed in is normal.
      if (hadSession.current) setSessionExpired(true);
      setUser(null);
    };
    window.addEventListener('auth:expired', handler);
    return () => window.removeEventListener('auth:expired', handler);
  }, []);

  const login = useCallback(async (username, password) => {
    const data = await api.login(username, password);
    setSessionExpired(false);
    // Keep the same shape /me returns, so a fresh login and a page reload
    // produce an identical user object.
    setUser({ id: data.id, username: data.username });
    return data;
  }, []);

  const logout = useCallback(async () => {
    await api.logout().catch(() => {});
    // A deliberate sign-out is not an expiry — do not greet them with a notice
    // telling them their session ended.
    setSessionExpired(false);
    setUser(null);
  }, []);

  // Stable so consumers can depend on it without re-running effects.
  const value = useMemo(() => ({
    user,
    loading,
    login,
    logout,
    sessionExpired,
  }), [user, loading, login, logout, sessionExpired]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
