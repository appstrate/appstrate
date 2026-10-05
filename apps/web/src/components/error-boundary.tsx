// SPDX-License-Identifier: Apache-2.0

import { Component, type ReactNode, type ErrorInfo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { isChunkLoadError, reloadOnceForChunkError } from "@/lib/chunk-reload";

interface Props {
  children: ReactNode;
  /** A caught error is dropped when this changes: the boundary around the routed page passes the pathname. */
  resetKey?: string;
}

interface State {
  hasError: boolean;
  /**
   * Chunk-load recovery status. `null` = chunk error caught, reload decision
   * pending in componentDidCatch (render nothing to avoid a fallback flash);
   * `true` = one-shot reload underway (keep rendering nothing); `false` =
   * not a chunk error, or the reload guard already fired this session —
   * render the normal retry fallback.
   */
  reloading: boolean | null;
}

/** No `error.message`: a render crash is an exception text (`o?.map is not a function`), not a sentence. */
function ErrorFallback({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="text-muted-foreground flex flex-col items-center justify-center py-16 text-center">
      <p>{t("error.unexpected")}</p>
      <p className="mt-2 text-sm">{t("error.unexpectedHint")}</p>
      <Button className="mt-4" onClick={onRetry}>
        {t("btn.retry")}
      </Button>
    </div>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false, reloading: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, reloading: isChunkLoadError(error) ? null : false };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo) {
    // Stale-chunk failures after a redeploy are unrecoverable from inside
    // React — the rejected lazy() payload is cached, so the Retry button
    // would re-throw forever. Hard-reload once instead; the shared
    // sessionStorage guard (chunk-reload.ts) prevents reload loops, and when
    // it has already fired we fall back to the normal error UI.
    if (isChunkLoadError(error)) {
      this.setState({ reloading: reloadOnceForChunkError() });
    }
    // Non-chunk errors are already surfaced via getDerivedStateFromError → ErrorFallback.
  }

  override componentDidUpdate(prev: Props) {
    if (this.state.hasError && prev.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, reloading: false });
    }
  }

  override render() {
    if (this.state.hasError) {
      // Chunk error pending decision or reload in flight — render nothing so
      // the retry UI never flashes before the page reloads.
      if (this.state.reloading !== false) {
        return null;
      }
      return <ErrorFallback onRetry={() => this.setState({ hasError: false, reloading: false })} />;
    }
    return this.props.children;
  }
}
