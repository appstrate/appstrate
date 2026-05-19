// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "./spinner";
import { RunModal } from "./run-modal";
import { ConnectionSummaryModal } from "./connection-summary-modal";
import {
  MissingConnectionsModal,
  type MissingIntegrationFieldError,
} from "./missing-connections-modal";
import { useRunAgent } from "../hooks/use-mutations";
import { usePackageDetail } from "../hooks/use-packages";
import { hasDisconnectedProviders } from "../lib/provider-status";
import { packageDetailPath } from "../lib/package-paths";
import { usePermissions } from "../hooks/use-permissions";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { readAgentConnectionPicks } from "../hooks/use-agent-connection-picks";
import { ApiError } from "../api";
import type { AgentDetail } from "@appstrate/shared-types";

interface RunAgentButtonProps {
  packageId: string;
  /** When provided, skips the lazy fetch (detail page case). */
  detail?: AgentDetail;
  version?: string;
  disabled?: boolean;
  disabledTitle?: string;
  variant?: "default" | "ghost" | "outline";
  size?: "default" | "sm" | "icon";
  className?: string;
  showLabel?: boolean;
}

export function RunAgentButton({
  packageId,
  detail: providedDetail,
  version,
  disabled,
  disabledTitle,
  variant = "default",
  size = "default",
  className,
  showLabel = false,
}: RunAgentButtonProps) {
  const { t } = useTranslation(["agents"]);
  const navigate = useNavigate();
  const { isMember } = usePermissions();
  const applicationId = useCurrentApplicationId();
  const runAgent = useRunAgent(packageId);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  const [missingErrors, setMissingErrors] = useState<MissingIntegrationFieldError[] | null>(null);

  /**
   * Read the member's pre-run picks (R3) and merge as `connectionOverrides`.
   * Returns `undefined` when no picks exist so the resolver's normal cascade
   * (admin pin > fallback) still applies.
   */
  const pickConnectionOverrides = (): Record<string, Record<string, string>> | undefined => {
    if (!applicationId) return undefined;
    const picks = readAgentConnectionPicks(applicationId, packageId);
    return Object.keys(picks).length > 0 ? picks : undefined;
  };

  // Intercept 412 missing_integration_connection — surface the recovery
  // modal instead of (or alongside) the generic toast. Set via the
  // per-call onError so we open the modal in response to a user action
  // (passes the react-hooks/set-state-in-effect rule) rather than mirroring
  // the mutation's error state in a useEffect.
  const onRunError = (err: unknown) => {
    if (
      err instanceof ApiError &&
      err.status === 412 &&
      err.code === "missing_integration_connection"
    ) {
      const errors = Array.isArray(err.details)
        ? (err.details as MissingIntegrationFieldError[])
        : [];
      setMissingErrors(errors);
    }
  };

  // Skip the lazy fetch when the parent already provided the detail.
  const { data: fetchedDetail, isFetching } = usePackageDetail(
    "agent",
    providedDetail ? undefined : packageId,
  );

  const detail: AgentDetail | undefined = providedDetail ?? fetchedDetail;

  const providers = detail?.dependencies?.providers ?? [];
  const hasProviders = providers.length > 0;
  const hasDisconnected = hasDisconnectedProviders(providers);

  /** Called after the connection summary is confirmed (or skipped if no providers). */
  const proceedAfterSummary = () => {
    setSummaryOpen(false);
    const agentHasInput =
      !!detail?.input?.schema?.properties && Object.keys(detail.input.schema.properties).length > 0;
    if (!agentHasInput) {
      runAgent.mutate(
        { version, connectionOverrides: pickConnectionOverrides() },
        { onError: onRunError },
      );
      return;
    }
    setInputOpen(true);
  };

  /** Start the run agent: show summary if providers, otherwise proceed directly. */
  const startRun = () => {
    if (hasProviders) {
      setSummaryOpen(true);
    } else {
      proceedAfterSummary();
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Detail already available (provided or fetched via React Query)
    if (detail) {
      startRun();
      return;
    }

    // Fetch hasn't completed yet — surface a generic error rather than racing
    toast.error(t("error.generic", { ns: "common" }));
  };

  const isPending = isFetching || runAgent.isPending;
  const isDisabled = disabled || isPending;

  if (!isMember) return null;

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
            <span className="bg-warning absolute -top-1 -right-1 size-2.5 rounded-full" />
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
            <span className="bg-warning absolute -top-1 -right-1 size-2.5 rounded-full" />
          )}
        </Button>
      )}

      {/* Connection summary — always shown before run when agent has providers */}
      {detail && (
        <ConnectionSummaryModal
          open={summaryOpen}
          onClose={() => setSummaryOpen(false)}
          onConfirm={proceedAfterSummary}
          onConfigureConnections={() => {
            setSummaryOpen(false);
            navigate(`${packageDetailPath("agent", packageId)}#connectors`);
          }}
          providers={detail.dependencies?.providers ?? []}
          appProfileName={detail.agentAppProfileName}
          isPending={runAgent.isPending}
        />
      )}

      {detail && (
        <RunModal
          open={inputOpen}
          onClose={() => setInputOpen(false)}
          agent={detail}
          onSubmit={(input) =>
            runAgent.mutate(
              { input, version, connectionOverrides: pickConnectionOverrides() },
              { onError: onRunError },
            )
          }
          isPending={runAgent.isPending}
        />
      )}

      <MissingConnectionsModal
        open={missingErrors !== null}
        onClose={() => {
          setMissingErrors(null);
          runAgent.reset();
        }}
        errors={missingErrors ?? []}
        retrying={runAgent.isPending}
        onRetryWithOverrides={(overrides) => {
          // Re-fire the run with the user's picks. Keep the modal open
          // until the response lands so the picker stays visible if the
          // server returns a fresh 412 (e.g. picks disappeared mid-flight).
          runAgent.mutate(
            { version, connectionOverrides: overrides },
            {
              onSuccess: () => setMissingErrors(null),
              onError: onRunError,
            },
          );
        }}
      />
    </>
  );
}
