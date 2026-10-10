// SPDX-License-Identifier: Apache-2.0

import { defaultRunVersion } from "../lib/version-selector";
import { useTranslation } from "react-i18next";
import { Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";
import { Spinner } from "./spinner";
import { DisabledReasonTooltip } from "./disabled-reason-tooltip";
import { RunModal } from "./run-modal";
import { RunLaunchRecovery } from "./run-launch-recovery";
import { useRunLauncher } from "../hooks/use-mutations";
import { useModalParam } from "../hooks/use-modal-param";
import { usePackageDetail } from "../hooks/use-packages";
import { usePermissions } from "../hooks/use-permissions";
import { isNeverPublishedForReader } from "../hooks/use-agent-readiness";
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
  /**
   * Render a non-blocking orange badge on the button when the agent's
   * integration connections are not ready for a run. Iso with the run-kickoff
   * 409 / MissingConnectionsModal (same server resolver), read from the
   * agent's diagnostics. Does NOT disable the button: the user can
   * still click Run and recover through the modal.
   */
  connectionWarning?: boolean;
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
  connectionWarning = false,
}: RunAgentButtonProps) {
  const { t } = useTranslation(["agents"]);
  const { can } = usePermissions();
  const launcher = useRunLauncher(packageId);
  // The input form's address: `?run=<agent>`, so the agent's own button answers it.
  const runParam = useModalParam("run");
  const inputOpen = runParam.value === packageId;

  // Skip the fetch when the parent already provided the detail (detail page
  // case). Otherwise the query stays DISABLED — list pages render N of these
  // buttons and eagerly fetching full agent detail per card caused an N+1
  // request burst on mount. The detail is fetched on demand via `refetch()`
  // in `handleClick` instead (and cached by React Query for the next click).
  const {
    data: fetchedDetail,
    isFetching,
    refetch,
  } = usePackageDetail("agent", providedDetail ? undefined : packageId, { enabled: inputOpen });

  const detail: AgentDetail | undefined = providedDetail ?? fetchedDetail;
  // Draft for whoever authors the package, no selector at all for everyone
  // else — see `defaultRunVersion`.
  const runVersion = version ?? defaultRunVersion(detail?.home_writable);

  /** Start the run: open the input modal when the agent declares input, else fire directly. */
  const startRun = (agentDetail: AgentDetail) => {
    // The deferred-fetch path reaches here with a detail the disabled state
    // never saw (list pages render this button without one). Same verdict,
    // said the same way, rather than a 404 toast that names no cause.
    if (isNeverPublishedForReader(agentDetail)) {
      toast.error(t("detail.titleNeverPublished"));
      return;
    }
    const agentHasInput =
      !!agentDetail.input?.schema?.properties &&
      Object.keys(agentDetail.input.schema.properties).length > 0;
    if (!agentHasInput) {
      launcher.launch({ version: version ?? defaultRunVersion(agentDetail.home_writable) });
      return;
    }
    runParam.open(packageId);
  };

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Detail already available (provided, or cached from a previous click)
    if (detail) {
      startRun(detail);
      return;
    }

    // Deferred fetch — `isFetching` drives the pending spinner meanwhile.
    void refetch().then((res) => {
      if (res.data) {
        startRun(res.data);
      } else {
        toast.error(t("error.generic", { ns: "common" }));
      }
    });
  };

  const neverPublished = isNeverPublishedForReader(detail);
  const isPending = isFetching || launcher.isPending;
  const isDisabled = disabled || isPending || neverPublished;
  const blockedTitle =
    disabled && disabledTitle
      ? disabledTitle
      : neverPublished
        ? t("detail.titleNeverPublished")
        : undefined;

  if (!can("agents:run")) return null;

  // Non-blocking warning dot — surfaced when integration connections aren't
  // ready, but the button stays clickable (recovery via MissingConnectionsModal).
  const warningDot = connectionWarning ? (
    <span
      className="absolute -top-1 -right-1 flex size-3"
      data-testid="run-connection-warning"
      title={t("detail.connectionWarning")}
    >
      <span className="bg-warning ring-background size-3 rounded-full ring-2" />
    </span>
  ) : null;

  return (
    <>
      <DisabledReasonTooltip reason={blockedTitle}>
        {showLabel ? (
          <Button
            variant={variant}
            size={size}
            onClick={handleClick}
            disabled={isDisabled}
            title={blockedTitle ? undefined : t("detail.run")}
            className={cn("relative", className)}
          >
            {isPending ? (
              <Spinner />
            ) : (
              <Play className={cn("size-3.5", variant === "outline" && "text-primary")} />
            )}
            {t("detail.run")}
            {warningDot}
          </Button>
        ) : (
          <Button
            variant={variant}
            size={size}
            className={cn("relative", className)}
            onClick={handleClick}
            disabled={isDisabled}
            title={blockedTitle ? undefined : t("detail.run")}
            aria-label={t("detail.run")}
          >
            {isPending ? <Spinner /> : <Play size={14} />}
            {warningDot}
          </Button>
        )}
      </DisabledReasonTooltip>

      {detail && (
        <RunModal
          open={inputOpen}
          onClose={runParam.close}
          agent={detail}
          onSubmit={(input) => launcher.launch({ input, version: runVersion })}
          isPending={launcher.isPending}
        />
      )}

      <RunLaunchRecovery
        launcher={launcher}
        packageId={packageId}
        integrationEntries={detail?.dependencies.integrations}
      />
    </>
  );
}
