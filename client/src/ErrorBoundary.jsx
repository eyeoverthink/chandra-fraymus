import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo });
    try {
      fetch('/api/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: error?.message,
          stack: error?.stack,
          component: errorInfo?.componentStack,
          view: this.props.label || 'unknown',
          ts: Date.now(),
        }),
      }).catch(() => {});
    } catch {}
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', padding: 40, minHeight: 200, gap: 16,
          color: '#e0e0e8', textAlign: 'center',
        }}>
          <div style={{ fontSize: 36, opacity: 0.4 }}>⚠</div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: '#f87171' }}>
            {this.props.label || 'Component'} crashed
          </h3>
          <p style={{ margin: 0, fontSize: 13, color: '#888', maxWidth: 400 }}>
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <button onClick={this.handleRetry} style={{
            padding: '8px 20px', background: '#a78bfa22', border: '1px solid #a78bfa44',
            borderRadius: 8, color: '#a78bfa', cursor: 'pointer', fontSize: 13,
            fontWeight: 500, transition: 'all 0.15s',
          }}>
            Retry
          </button>
          {this.state.errorInfo && (
            <details style={{ marginTop: 8, fontSize: 11, color: '#555', maxWidth: 500, textAlign: 'left' }}>
              <summary style={{ cursor: 'pointer', color: '#666' }}>Stack trace</summary>
              <pre style={{
                marginTop: 8, padding: 12, background: '#111118', borderRadius: 6,
                overflow: 'auto', maxHeight: 200, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              }}>
                {this.state.error?.stack}
              </pre>
            </details>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
