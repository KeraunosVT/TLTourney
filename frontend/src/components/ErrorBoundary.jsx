import { Component } from 'react';

// Wraps the page, not the shell. A crash in one page leaves the nav standing so
// the fallback has somewhere to send you, and navigating away clears it.
//
// This exists because of a real failure: /api/signup/pool returned a different
// shape when no tournament was running, the page dereferenced a field that
// wasn't there, and React unmounted the ENTIRE app. What the user saw was a
// white screen — no message, no nav, nothing to click — for what was, at heart,
// a missing database row. A blank page is the worst possible way to report a
// problem, because it looks identical to the site being down.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Still log it — the boundary makes the failure survivable, not invisible.
    console.error('Page crashed:', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="px-6 py-10 max-w-[640px] mx-auto">
        <div className="panel p-6">
          <h1 className="font-display text-[22px] mb-2">This page hit a problem</h1>
          <p className="text-sm text-ash leading-relaxed mb-4">
            Something on this page didn't load the way it expected. The rest of the site still
            works — try reloading, and tell an organizer if it keeps happening.
          </p>
          <pre
            className="mono text-[11px] text-ash bg-panelup border border-line rounded p-3
                       overflow-x-auto whitespace-pre-wrap break-words mb-4"
          >
            {String(this.state.error?.message || this.state.error)}
          </pre>
          <button
            onClick={() => { this.setState({ error: null }); window.location.reload(); }}
            className="px-4 py-2 rounded border border-crimson/60 bg-crimson/15 text-crimsonbright
                       text-sm font-semibold hover:bg-crimson/25"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
