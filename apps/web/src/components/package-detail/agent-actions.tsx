// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { schemaHasFileFields } from "@appstrate/core/form";
import type { AgentDetail } from "@appstrate/shared-types";
import { useDeletePackage, usePackageDetail } from "../../hooks/use-packages";
import { agentLaunchRefusal } from "../../hooks/use-agent-readiness";
import { useAgentMemories, useDeleteAgentMemories } from "../../hooks/use-persistence";
import { useDeleteAgentRuns, useRunLauncher } from "../../hooks/use-mutations";
import { usePermissions } from "../../hooks/use-permissions";
import { useAgentRunSpace, useAgentSpaceAction } from "../../hooks/use-agent-run-space";
import { useOverviewMode } from "../../hooks/use-overview-mode";
import { useSpaceLabelOf } from "../../hooks/use-spaces";
import { spaceStore } from "../../stores/space-store";
import { PackageActionsDropdown } from "./package-actions-dropdown";
import { deedOfAction } from "./space-deed";
import { useBundleDeed, useClearRunsDeed } from "./use-agent-deeds";
import { ConfirmModal } from "../confirm-modal";
import { RunWithOptionsModal } from "../run-with-options-modal";
import { RunLaunchRecovery } from "../run-launch-recovery";
import { launchFromOptions } from "../../lib/run-launch";
import { NewScheduleModal } from "../new-schedule-modal";

type Confirmation = "deleteAgent" | "clearRuns" | "clearMemories";

/** The title of each confirmation names its act; the button repeats the verb. */
const CONFIRM_TEXT: Record<Confirmation, { title: string; description: string }> = {
  deleteAgent: { title: "detail.deleteTitle", description: "detail.deleteConfirm" },
  clearRuns: { title: "detail.clearRunsTitle", description: "detail.clearRunsConfirm" },
  clearMemories: {
    title: "detail.clearMemoriesTitle",
    description: "detail.clearMemoriesConfirm",
  },
};

export function AgentActions({
  packageId,
  isHistoricalVersion,
  downloadVersion,
  downloadPackage,
  downloadBundle,
  onCreateVersion,
  unsavedReason,
  catalogueVersion,
}: {
  packageId: string;
  isHistoricalVersion: boolean;
  downloadVersion: string | undefined;
  downloadPackage: (v: string) => void;
  /** Export the agent + transitive deps as a single .afps-bundle. */
  downloadBundle?: (v?: string) => void;
  onCreateVersion: () => void;
  /** Set while the page holds unsaved definition edits a version or run would not carry. */
  unsavedReason?: string;
  /** The published version the catalogue sheet opens on (`catalogueVersionFor`). */
  catalogueVersion?: string;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const { can } = usePermissions();
  const { on: overview } = useOverviewMode();
  const spaceLabelOf = useSpaceLabelOf();
  const { data: detail } = usePackageDetail("agent", packageId);
  const { data: memories } = useAgentMemories(packageId);
  const deleteAgent = useDeletePackage("agent");
  const deleteRuns = useDeleteAgentRuns(packageId);
  const deleteAllMemories = useDeleteAgentMemories(packageId);
  const launcher = useRunLauncher(packageId);
  // The space a confirmation acts in, kept while its dialog fades out.
  const [confirming, setConfirming] = useState<{
    kind: Confirmation;
    spaceId: string | null;
  } | null>(null);
  const [newScheduleOpen, setNewScheduleOpen] = useState(false);
  const [runOptionsOpen, setRunOptionsOpen] = useState(false);
  // In « Tous les espaces », each deed below asks its space among the agent's: the page names none.
  const runSpace = useAgentRunSpace(packageId, detail?.space_ids, { preferWorkingSpace: false });
  const scheduleSpace = useAgentSpaceAction(packageId, "schedules:write", detail?.space_ids, {
    preferWorkingSpace: false,
  });
  const memoriesSpace = useAgentSpaceAction(packageId, "persistence:delete", detail?.space_ids, {
    preferWorkingSpace: false,
  });
  const clearRuns = useClearRunsDeed(packageId, detail, (spaceId) =>
    setConfirming({ kind: "clearRuns", spaceId }),
  );
  const bundle = useBundleDeed(
    detail,
    downloadBundle ? () => downloadBundle(downloadVersion) : undefined,
  );

  if (!detail) return null;

  // Not the full run verdict: the options modal picks the model and the version.
  const refusal = agentLaunchRefusal(detail, { anySpace: overview });
  const runBlockedReason = refusal ? t(refusal) : unsavedReason;
  const canRunWithOptions = can("agents:run") && !runBlockedReason;
  // Opened once in the space: the modal reads the agent of the space entered.
  const openRunOptions = () => {
    runSpace.enteredDetail();
    setRunOptionsOpen(true);
  };
  // Asked once in the space: the deletion runs in the space entered.
  const confirmMemories = () => {
    memoriesSpace.enteredDetail();
    setConfirming({ kind: "clearMemories", spaceId: spaceStore.getState().id });
  };
  const openNewSchedule = () => {
    scheduleSpace.enteredDetail();
    setNewScheduleOpen(true);
  };
  const clearMemories = deedOfAction(
    memoriesSpace,
    t("common:spaceChoice.clearMemories"),
    confirmMemories,
  );
  const pendingConfirmation =
    deleteAgent.isPending || deleteRuns.isPending || deleteAllMemories.isPending;

  const confirm = () => {
    const onSuccess = () => setConfirming(null);
    if (confirming?.kind === "deleteAgent") deleteAgent.mutate(detail.id, { onSuccess });
    else if (confirming?.kind === "clearRuns" && confirming.spaceId) {
      deleteRuns.mutate(confirming.spaceId, { onSuccess });
    } else if (confirming?.kind === "clearMemories" && confirming.spaceId) {
      deleteAllMemories.mutate(confirming.spaceId, { onSuccess });
    }
  };
  const confirmText = confirming && CONFIRM_TEXT[confirming.kind];
  const confirmSpace = confirming?.spaceId
    ? (spaceLabelOf(confirming.spaceId) ?? confirming.spaceId)
    : "";

  return (
    <>
      <PackageActionsDropdown
        packageId={packageId}
        type="agent"
        detail={detail}
        isHistoricalVersion={isHistoricalVersion}
        downloadVersion={downloadVersion}
        onDownload={downloadPackage}
        // Whether the agent RUNS in the working space, off the response the menu already has: a
        // system agent is no exception, and a caller the library stays silent about (a `runner`
        // holds no `agents:read`) still gets a verdict.
        isActiveHere={detail.active}
        onCreateVersion={onCreateVersion}
        createVersionBlockedReason={unsavedReason}
        catalogueVersion={catalogueVersion}
        agent={{
          runWithOptions: deedOfAction(runSpace, t("common:spaceChoice.run"), openRunOptions),
          runBlockedReason,
          addSchedule: {
            ...deedOfAction(scheduleSpace, t("common:spaceChoice.schedule"), openNewSchedule),
            // A schedule cannot carry a file input.
            offered: scheduleSpace.offered && !schemaHasFileInput(detail),
          },
          bundle,
          clearRuns,
          clearMemories: {
            ...clearMemories,
            // With a working space, only once it holds memories.
            offered: clearMemories.offered && (overview || (!!memories && memories.length > 0)),
          },
          onDeleteAgent: () => setConfirming({ kind: "deleteAgent", spaceId: null }),
        }}
      />
      <RunWithOptionsModal
        open={runOptionsOpen && canRunWithOptions}
        onClose={() => setRunOptionsOpen(false)}
        agent={detail}
        isPending={launcher.isPending}
        onSubmit={(submit) => launcher.launch(launchFromOptions(submit))}
      />
      {newScheduleOpen && (
        <NewScheduleModal initialAgentId={packageId} onClose={() => setNewScheduleOpen(false)} />
      )}
      <RunLaunchRecovery
        launcher={launcher}
        packageId={packageId}
        integrationEntries={detail.dependencies.integrations}
      />
      <ConfirmModal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={confirm}
        title={confirmText ? t(confirmText.title) : ""}
        description={
          confirmText
            ? t(confirmText.description, { name: detail.display_name, space: confirmSpace })
            : ""
        }
        confirmLabel={t("btn.delete", { ns: "common" })}
        isPending={pendingConfirmation}
      />
    </>
  );
}

function schemaHasFileInput(detail: AgentDetail): boolean {
  return !!schemaHasFileFields(detail.input?.schema);
}
