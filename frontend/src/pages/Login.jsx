import { useState, useEffect } from 'react';
import { useNavigate, Navigate, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { cardVariants } from '../lib/motion.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { IconAlert, IconBrand, IconHide, IconLock, IconShield, IconUser, IconView, IconWarning, ICON_MD } from '../lib/icons.jsx';

export default function Login() {
  const { login, user, loading: authLoading, sessionExpired } = useAuth();
  const navigate        = useNavigate();
  const location        = useLocation();

  // Where the user was when the session ended, so signing back in returns them
  // there instead of to the Dashboard. Only in-app paths are honoured — a
  // `from` is router state, and an absolute URL there would be an open redirect.
  useEffect(() => { document.title = 'Sign in · StockFlow'; }, []);

  const rawFrom  = location.state?.from;
  const redirect = typeof rawFrom === 'string' && rawFrom.startsWith('/') && !rawFrom.startsWith('//')
    ? rawFrom
    : '/';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [showPw, setShowPw]     = useState(false);
  // Caps Lock is the single most common reason a correct password is rejected.
  const [capsOn, setCapsOn]     = useState(false);

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
    <div className="auth-wrapper">
      <motion.div className="login-card" variants={cardVariants} initial="initial" animate="animate">
        {/* Brand */}
        <div className="login-brand">
          <div className="login-brand-icon"><IconBrand size={26} color="#fff" /></div>
          <h1>StockFlow</h1>
          <p>Inventory Management &amp; Invoicing</p>
        </div>

        {/* Why they are looking at this form. Shown until they type — a
            failed login attempt replaces it with the real error. */}
        {sessionExpired && !error && (
          <div className="login-notice" role="status">
            <IconWarning size={ICON_MD} />
            <span>
              Your session ended, so you were signed out.
              {redirect !== '/' && ' Sign in to pick up where you left off.'}
            </span>
          </div>
        )}

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
                type={showPw ? 'text' : 'password'}
                placeholder="Enter your password"
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyUp={trackCaps}
                onKeyDown={trackCaps}
                onBlur={() => setCapsOn(false)}
                style={{ paddingRight: 38 }}
              />
              <button
                type="button"
                className="input-affix-btn"
                onClick={() => setShowPw(s => !s)}
                aria-label={showPw ? 'Hide password' : 'Show password'}
                title={showPw ? 'Hide password' : 'Show password'}
              >
                {showPw ? <IconHide size={ICON_MD} /> : <IconView size={ICON_MD} />}
              </button>
            </div>
            {capsOn && (
              <small className="field-hint" role="status">
                <IconWarning size={12} /> Caps Lock is on.
              </small>
            )}
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

        {/* "Secured with JWT authentication" was an implementation detail
            dressed up as reassurance — it tells a user nothing they can act on
            and names the mechanism to anyone probing the login. */}
        <div className="login-footer">
          <IconShield size={ICON_MD} /> Your session is encrypted and signs out automatically.
        </div>
      </motion.div>
    </div>
  );
}
