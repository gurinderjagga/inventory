import { useState, useEffect } from 'react';
import { useNavigate, Navigate, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { cardVariants } from '../lib/motion.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { IconAlert, IconBrand, IconHide, IconLock, IconShield, IconUser, IconView, IconWarning, ICON_MD } from '../lib/icons.jsx';

export default function Login() {
  const { login, user, loading: authLoading, sessionExpired } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Where the user was when the session ended, so signing back in returns them
  // there instead of to the Dashboard. Only in-app paths are honoured — a
  // `from` is router state, and an absolute URL there would be an open redirect.
  useEffect(() => { document.title = 'Sign in · StockFlow'; }, []);

  const rawFrom = location.state?.from;
  const redirect = typeof rawFrom === 'string' && rawFrom.startsWith('/') && !rawFrom.startsWith('//')
    ? rawFrom
    : '/';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPw, setShowPw] = useState(false);
  // Caps Lock is the single most common reason a correct password is rejected.
  const [capsOn, setCapsOn] = useState(false);

  const trackCaps = (e) => {
    const on = e.getModifierState?.('CapsLock');
    if (typeof on === 'boolean') setCapsOn(on);
  };

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
      navigate(redirect, { replace: true });
    } catch (err) {
      setError(err.message || 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Already signed in — send them to the app instead of showing a login form
  // they do not need. Declared after every hook so hook order stays stable.
  if (!authLoading && user) return <Navigate to={redirect} replace />;

  return (
    <div className="auth-minimal-wrapper">
      <motion.div className="login-minimal-card" variants={cardVariants} initial="initial" animate="animate">
        
        <div className="login-minimal-header">
          <div className="login-minimal-icon"><IconBrand size={28} color="#fff" /></div>
          <h1 className="login-minimal-title">Sign in to StockFlow</h1>
          <p className="login-minimal-subtitle">Enter your details to access your account</p>
        </div>

        {sessionExpired && !error && (
          <div className="login-notice" role="status">
            <IconWarning size={ICON_MD} />
            <span>Your session ended. Sign in again to continue.</span>
          </div>
        )}

        {error && (
          <div className="login-error">
            <IconAlert size={ICON_MD} />
            <span>{error}</span>
          </div>
        )}

        <form className="login-minimal-form" onSubmit={handleSubmit} noValidate>
          <div className="minimal-form-group">
            <label htmlFor="login-username">Username</label>
            <input
              id="login-username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoFocus
              className="minimal-input"
            />
          </div>

          <div className="minimal-form-group">
            <div className="minimal-label-row">
              <label htmlFor="login-password">Password</label>
              <a href="#" className="minimal-forgot-link" onClick={e => e.preventDefault()}>Forgot password?</a>
            </div>
            <div className="minimal-pw-wrap">
              <input
                id="login-password"
                type={showPw ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyUp={trackCaps}
                onKeyDown={trackCaps}
                onBlur={() => setCapsOn(false)}
                className="minimal-input"
                style={{ paddingRight: 40 }}
              />
              <button
                type="button"
                className="minimal-pw-toggle"
                onClick={() => setShowPw(s => !s)}
                aria-label={showPw ? 'Hide password' : 'Show password'}
                title={showPw ? 'Hide password' : 'Show password'}
              >
                {showPw ? <IconHide size={16} /> : <IconView size={16} />}
              </button>
            </div>
            {capsOn && (
              <small className="field-hint" role="status" style={{ marginTop: 6 }}>
                <IconWarning size={12} /> Caps Lock is on.
              </small>
            )}
          </div>

          <button
            type="submit"
            className="btn btn-minimal"
            disabled={loading}
          >
            {loading
              ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Signing in…</>
              : 'Sign in'}
          </button>
        </form>
      </motion.div>
    </div>
  );
}
