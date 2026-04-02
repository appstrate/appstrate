// SPDX-License-Identifier: Apache-2.0

import { Component, type ReactNode, type ErrorInfo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

function ErrorFallback({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="text-muted-foreground flex flex-col items-center justify-center py-16 text-center">
      <p>{t("error.unexpected")}</p>
      <p className="text-muted-foreground mt-2 text-sm">{error?.message || t("error.unknown")}</p>
      <Button className="mt-4" onClick={onRetry}>
        {t("btn.retry")}
      </Button>
    </div>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Errors are already surfaced via getDerivedStateFromError → ErrorFallback
  }

  override render() {
    if (this.state.hasError) {
      return (
        <ErrorFallback
          error={this.state.error}
          onRetry={() => this.setState({ hasError: false, error: null })}
        />
      );
    }
    return this.props.children;
  }
}
