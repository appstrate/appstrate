import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="empty-state">
          <p>Une erreur inattendue est survenue.</p>
          <p className="empty-hint">{this.state.error?.message || "Erreur inconnue"}</p>
          <button
            className="error-retry"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Reessayer
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
