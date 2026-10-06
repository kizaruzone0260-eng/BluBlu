import { Component, type ErrorInfo, type ReactNode } from 'react';
import ErrorScreen from '../pages/ErrorScreen';

interface State { errored: boolean }

/**
 * Hardening Phase 3: top-level error boundary so a runtime React error renders
 * the friendly, translated 500 screen instead of a blank white page (and never
 * a stack trace). Resetting just reloads.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { errored: false };
  static getDerivedStateFromError(): State { return { errored: true }; }
  componentDidCatch(_err: Error, _info: ErrorInfo): void { /* no secret data logged client-side */ }
  render(): ReactNode {
    return this.state.errored ? <ErrorScreen kind="500" /> : this.props.children;
  }
}
