import { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { cardVariants } from '../lib/motion.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { IconAlert, IconBrand, IconLock, IconShield, IconUser, ICON_MD } from '../lib/icons.jsx';

export default function Login() {
  const { login, user, loading: authLoading } = useAuth();
  const navigate        = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('Please enter both username and password.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await login(username.trim(), password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message || 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Already signed in — send them to the app instead of showing a login form
  // they do not need. Declared after every hook so hook order stays stable.
  if (!authLoading && user) return <Navigate to="/" replace />;

  return (
    <div className="auth-wrapper">
      <motion.div className="login-card" variants={cardVariants} initial="initial" animate="animate">
        {/* Brand */}
        <div className="login-brand">
          <div className="login-brand-icon"><IconBrand size={26} color="#fff" /></div>
          <h1>StockFlow</h1>
          <p>Inventory Management &amp; Invoicing</p>
        </div>

        {/* Error */}
        {error && (
          <div className="login-error">
            <IconAlert size={ICON_MD} />
            <span>{error}</span>
          </div>
        )}

        {/* Form */}
        <form className="login-form" onSubmit={handleSubmit} noValidate>
          <div className="form-group">
            <label htmlFor="login-username">Username</label>
            <div className="input-icon-wrap">
              <IconUser size={ICON_MD} />
              <input
                id="login-username"
                type="text"
                placeholder="Enter your username"
                autoComplete="username"
                value={username}
                onChange={e => setUsername(e.target.value)}
                autoFocus
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="login-password">Password</label>
            <div className="input-icon-wrap">
              <IconLock size={ICON_MD} />
              <input
                id="login-password"
                type="password"
                placeholder="Enter your password"
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
            </div>
          </div>

          <button
            type="submit"
            className="btn btn-primary w-full"
            disabled={loading}
            style={{ justifyContent: 'center', padding: '11px' }}
          >
            {loading
              ? <><span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Signing in…</>
              : 'Sign In'}
          </button>
        </form>

        <div className="login-footer">
          <IconShield size={ICON_MD} /> Secured with JWT authentication
        </div>
      </motion.div>
    </div>
  );
}
