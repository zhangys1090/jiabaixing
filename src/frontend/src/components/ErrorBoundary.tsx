import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorLevel, errorMonitor } from '../utils/errorMonitoring';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[ErrorBoundary] Caught an error:', error);
    console.error('[ErrorBoundary] Component stack:', errorInfo.componentStack);
    errorMonitor.reportCustomError(`[ErrorBoundary] ${error.message}`, ErrorLevel.ERROR, {
      componentStack: errorInfo.componentStack,
      errorStack: error.stack,
    });
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '48px 24px',
            textAlign: 'center',
            color: 'var(--text-secondary, #888)',
            fontFamily: 'var(--font-family, system-ui, sans-serif)',
          }}
        >
          <div
            style={{
              fontSize: '48px',
              marginBottom: '16px',
              lineHeight: 1,
            }}
          >
            ⚠️
          </div>
          <h3
            style={{
              margin: '0 0 8px',
              fontSize: '18px',
              fontWeight: 600,
              color: 'var(--text-primary, #e0e0e0)',
            }}
          >
            Something went wrong
          </h3>
          <p
            style={{
              margin: '0 0 20px',
              fontSize: '14px',
              maxWidth: '400px',
              lineHeight: 1.5,
              wordBreak: 'break-word',
            }}
          >
            {this.state.error?.message || 'An unexpected error occurred while rendering this module.'}
          </p>
          <button
            onClick={this.handleRetry}
            style={{
              padding: '8px 24px',
              fontSize: '14px',
              fontWeight: 500,
              border: '1px solid var(--border-color, #444)',
              borderRadius: '6px',
              background: 'var(--bg-secondary, #2a2a2a)',
              color: 'var(--text-primary, #e0e0e0)',
              cursor: 'pointer',
              transition: 'background 0.15s ease',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-hover, #333)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-secondary, #2a2a2a)';
            }}
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
