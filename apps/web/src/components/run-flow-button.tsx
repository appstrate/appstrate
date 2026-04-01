import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "./spinner";
import { InputModal } from "./input-modal";
import { ConnectionSummaryModal } from "./connection-summary-modal";
import { useRunFlow } from "../hooks/use-mutations";
import { api } from "../api";
import { hasDisconnectedProviders } from "../lib/provider-status";
import type { FlowDetail } from "@appstrate/shared-types";

interface RunFlowButtonProps {
  packageId: string;
  /** When provided, skips the lazy fetch (detail page case). */
  detail?: FlowDetail;
  version?: string;
  disabled?: boolean;
  disabledTitle?: string;
  variant?: "default" | "ghost" | "outline";
  size?: "default" | "sm" | "icon";
  className?: string;
  showLabel?: boolean;
  /** Called when user clicks "Configure connections" in the summary modal. */
  onConfigureConnections?: () => void;
}

export function RunFlowButton({
  packageId,
  detail: providedDetail,
  version,
  disabled,
  disabledTitle,
  variant = "default",
  size = "default",
  className,
  showLabel = false,
  onConfigureConnections: onConfigureConnectionsProp,
}: RunFlowButtonProps) {
  const { t } = useTranslation(["flows"]);
  const navigate = useNavigate();
  const runFlow = useRunFlow(packageId);
  const [fetchedDetail, setFetchedDetail] = useState<FlowDetail | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  const [fetching, setFetching] = useState(false);

  const detail = providedDetail ?? fetchedDetail;

  const providers = detail?.dependencies?.providers ?? [];
  const hasProviders = providers.length > 0;
  const hasDisconnected = hasDisconnectedProviders(providers);
  const hasInputSchema = !!(
    detail?.input?.schema?.properties && Object.keys(detail.input.schema.properties).length > 0
  );

  /** Called after the connection summary is confirmed (or skipped if no providers). */
  const proceedAfterSummary = () => {
    setSummaryOpen(false);
    if (hasInputSchema) {
      setInputOpen(true);
    } else {
      runFlow.mutate({ version });
    }
  };

  /** Start the run flow: show summary if providers, otherwise proceed directly. */
  const startRun = () => {
    if (hasProviders) {
      setSummaryOpen(true);
    } else {
      proceedAfterSummary();
    }
  };

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (providedDetail) {
      startRun();
      return;
    }

    // Lazy fetch for list page
    setFetching(true);
    try {
      const data = await api<{ flow: FlowDetail }>(`/packages/flows/${packageId}`);
      setFetchedDetail(data.flow);

      const flowHasProviders = (data.flow.dependencies?.providers?.length ?? 0) > 0;
      if (flowHasProviders) {
        setSummaryOpen(true);
      } else {
        const needsInput = !!(
          data.flow.input?.schema?.properties &&
          Object.keys(data.flow.input.schema.properties).length > 0
        );
        if (needsInput) {
          setInputOpen(true);
        } else {
          runFlow.mutate({});
        }
      }
    } catch {
      // Fetch errors are silent — user can retry
    } finally {
      setFetching(false);
    }
  };

  const isPending = fetching || runFlow.isPending;
  const isDisabled = disabled || isPending;

  return (
    <>
      {showLabel ? (
        <Button
          variant={variant}
          onClick={handleClick}
          disabled={isDisabled}
          title={disabled ? disabledTitle : t("detail.run")}
          className="relative"
        >
          {isPending ? <Spinner /> : t("detail.run")}
          {hasDisconnected && !isPending && (
            <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-warning" />
          )}
        </Button>
      ) : (
        <Button
          variant={variant}
          size={size}
          className={`relative ${className ?? ""}`}
          onClick={handleClick}
          disabled={isDisabled}
          title={disabled ? disabledTitle : t("detail.run")}
        >
          {isPending ? <Spinner /> : <Play size={14} />}
          {hasDisconnected && !isPending && (
            <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-warning" />
          )}
        </Button>
      )}

      {/* Connection summary — always shown before execution when flow has providers */}
      {detail && (
        <ConnectionSummaryModal
          open={summaryOpen}
          onClose={() => setSummaryOpen(false)}
          onConfirm={proceedAfterSummary}
          onConfigureConnections={() => {
            setSummaryOpen(false);
            if (onConfigureConnectionsProp) {
              onConfigureConnectionsProp();
            } else {
              navigate({ hash: "connectors" }, { replace: true });
            }
          }}
          providers={detail.dependencies?.providers ?? []}
          orgProfileName={detail.flowOrgProfileName}
          isPending={runFlow.isPending}
        />
      )}

      {/* Input modal — shown after summary confirmation if flow has input schema */}
      {detail && (
        <InputModal
          open={inputOpen}
          onClose={() => setInputOpen(false)}
          flow={detail}
          onSubmit={(input, files) => runFlow.mutate({ input, files, version })}
          isPending={runFlow.isPending}
        />
      )}
    </>
  );
}
