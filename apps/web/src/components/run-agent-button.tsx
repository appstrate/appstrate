// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PendingButton } from "@/components/app-ui/pending-button";
import { defaultRunVersion } from "../lib/version-selector";
import { useTranslation } from "react-i18next";
import { Play } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@appstrate/ui/cn";
import { DisabledReasonTooltip } from "./disabled-reason-tooltip";
import { SpaceChoiceDropdown } from "./space-choice-menu";
import { RunModal } from "./run-modal";
import { RunLaunchRecovery } from "./run-launch-recovery";
import { useRunLauncher } from "../hooks/use-mutations";
import { packageDetailQueryOptions, usePackageDetail } from "../hooks/use-packages";
import { useSpaceAction } from "../hooks/use-space-action";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useCurrentOrgId } from "../hooks/use-org";
import { spaceStore } from "../stores/space-store";
import { isNeverPublishedForReader } from "../hooks/use-agent-readiness";
import type { AgentDetail } from "@appstrate/shared-types";
import { agentHasInput, runInputOpens } from "../lib/run-input";

const NO_SPACES: readonly string[] = [];

interface RunAgentButtonProps {
  packageId: string;
  /**
   * The spaces of the index row offering the run: a click enters the granting space before
   * running; several granting it, the button opens their menu. The working space when absent.
   */
  spaceIds?: readonly string[];
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
  spaceIds = NO_SPACES,
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
  const { t } = useTranslation(["agents", "common"]);
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const workingSpaceId = useCurrentSpaceId();
  // Among the row's spaces, or the working space's alone.
  const runAction = useSpaceAction(
    { permission: "agents:run" },
    spaceIds.length > 0 ? spaceIds : workingSpaceId ? [workingSpaceId] : NO_SPACES,
  );
  const canRun = runAction.offered;
  // A row not of the working space: the detail query below reads the working space, so nothing
  // it holds is this row's until a click enters the row's space.
  const elsewhere = spaceIds.length > 0 && !spaceIds.includes(workingSpaceId ?? "");
  const launcher = useRunLauncher(packageId);
  const [inputOpen, setInputOpen] = useState(false);

  // Skip the fetch when the parent already provided the detail (detail page
  // case). Otherwise a click fetches on demand in `handleClick`: list pages
  // render N of these buttons, and fetching every detail on mount is an N+1.
  const { data: fetchedHere, isFetching: fetchingHere } = usePackageDetail(
    "agent",
    providedDetail ? undefined : packageId,
    { enabled: inputOpen },
  );
  const fetchedDetail = elsewhere ? undefined : fetchedHere;
  const isFetching = !elsewhere && fetchingHere;

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
    if (!agentHasInput(agentDetail)) {
      launcher.launch({ version: version ?? defaultRunVersion(agentDetail.home_writable) });
      return;
    }
    setInputOpen(true);
  };

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Runs in the space the action entered: the requests `start` sends read it when they leave.
    runAction.run(start);
  };

  const start = () => {
    const target = spaceStore.getState().id;
    // Detail already available (provided, or cached from a previous click) when it is the
    // target's: the one held is the working space's at the click.
    if (detail && target === workingSpaceId) {
      startRun(detail);
      return;
    }
    // Deferred fetch, on the key the detail query reads in the target space — `isFetching`
    // drives the pending spinner meanwhile.
    qc.fetchQuery(packageDetailQueryOptions("agent", { orgId, spaceId: target }, packageId)).then(
      startRun,
      () => toast.error(t("error.generic", { ns: "common" })),
    );
  };

  // Between several of the row's spaces, the button is the menu of them.
  const runIn = runAction.choose(t("common:spaceChoice.run"), start);

  const neverPublished = isNeverPublishedForReader(detail);
  const inputShown = runInputOpens({
    requested: inputOpen,
    disabled: !!disabled,
    canRun,
    detail,
  });
  const isPending = isFetching || launcher.isPending;
  const isDisabled = disabled || isPending || neverPublished;
  const blockedTitle =
    disabled && disabledTitle
      ? disabledTitle
      : neverPublished
        ? t("detail.titleNeverPublished")
        : undefined;

  if (!canRun) return null;

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
        <SpaceChoiceDropdown choice={isDisabled ? undefined : runIn}>
          <PendingButton
            variant={variant}
            size={size}
            className={cn("relative", className)}
            onClick={handleClick}
            pending={isPending}
            disabled={isDisabled}
            title={blockedTitle ? undefined : t("detail.run")}
            aria-label={showLabel ? undefined : t("detail.run")}
          >
            {!isPending && (
              <Play className={cn(showLabel && variant === "outline" && "text-primary")} />
            )}
            {showLabel && t("detail.run")}
            {warningDot}
          </PendingButton>
        </SpaceChoiceDropdown>
      </DisabledReasonTooltip>

      {detail && (
        <RunModal
          open={inputShown}
          onClose={() => setInputOpen(false)}
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
