import { Component } from 'react';

// Inside the router, so the fallback can offer a real link back, and around
// everything else, so a throw on any route shows a message rather than an
// empty document.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg px-6">
        <div className="card max-w-sm p-6 text-center">
          <h1 className="font-display text-lg font-semibold">Something broke</h1>
          <p className="mt-2 text-sm text-muted">
            That screen failed to load. Your listings and orders are fine — this
            is the dashboard, not your store.
          </p>
          <a
            href="/app.html"
            className="mt-4 inline-block rounded-pill bg-sidebar px-4 py-2 text-sm font-medium text-white"
          >
            Back to Overview
          </a>
        </div>
      </div>
    );
  }
}
