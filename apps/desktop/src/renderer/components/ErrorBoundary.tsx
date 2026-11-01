import { Component, type ReactNode } from 'react';

/** Keeps a failing panel or module from blanking the whole browser UI. */
export class ErrorBoundary extends Component<{ label: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[ui] ${this.props.label} crashed`, error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="boundary">
        <strong>{this.props.label} hit a problem.</strong>
        <span className="muted">{this.state.error.message}</span>
        <button className="btn" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
