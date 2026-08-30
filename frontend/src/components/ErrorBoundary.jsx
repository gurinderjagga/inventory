import { Component } from 'react';
import { IconAlert, IconRefresh, ICON_MD } from '../lib/icons.jsx';

/**
 * Catches render errors so one broken component does not take the page with it.
 *
 * Without this, a thrown error during render unmounts the entire React tree and
 * leaves a blank white page — no navigation, no message, nothing to act on. The
 * user's only recourse is guessing that a reload might help.
 *
 * Must be a class: there is no hook equivalent of componentDidCatch.
 *
 * Note what this does NOT catch — event handlers, async callbacks, and failed
 * fetches all reject outside the render pass. Those are already handled where
 * they happen, by the toast layer.
 */
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Until there is real error monitoring (Phase 5), the console is the only
    // place this is recoverable from.
    console.error('Unhandled render error:', error, info?.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  handleGoHome = () => {
    // A full navigation, not a router push: the tree is already broken, so
    // re-rendering it in place would just throw again.
    window.location.assign('/');
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="crash">
        <div className="crash-card" role="alert">
          <IconAlert />
          <h1>Something broke on this page</h1>
          <p>
            The error has been logged to the browser console. Your data is safe —
            nothing was saved or changed by this.
          </p>
          <div className="crash-actions">
            <button type="button" className="btn btn-primary" onClick={this.handleReload}>
              <IconRefresh size={ICON_MD} /> Reload the page
            </button>
            <button type="button" className="btn btn-secondary" onClick={this.handleGoHome}>
              Go to Dashboard
            </button>
          </div>
          {/* The message itself, for anyone reporting the fault. Kept visible
              rather than hidden behind the console, which most users never open. */}
          <p className="crash-detail">{String(this.state.error?.message || this.state.error)}</p>
        </div>
      </div>
    );
  }
}
