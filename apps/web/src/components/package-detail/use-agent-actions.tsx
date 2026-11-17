// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { schemaHasFileFields } from "@appstrate/core/form";
import { useDeletePackage, usePackageDetail } from "../../hooks/use-packages";
import { agentLaunchRefusal } from "../../hooks/use-agent-readiness";
import { useAgentMemories, useDeleteAgentMemories } from "../../hooks/use-persistence";
import { useDeleteAgentRuns, useRunLauncher } from "../../hooks/use-mutations";
import {
  useAgentLatestRunAcross,
  useAgentRunsInFlightAcross,
} from "../../hooks/use-paginated-runs";
import { usePermissions } from "../../hooks/use-permissions";
import { useAgentSpaceAction } from "../../hooks/use-agent-run-space";
import { useOverviewMode } from "../../hooks/use-overview-mode";
import { useSpacesFor } from "../../hooks/use-space-action";
import { useSpaceLabelOf } from "../../hooks/use-spaces";
import { launchFromOptions } from "../../lib/run-launch";
import { ConfirmModal } from "../confirm-modal";
import { RunWithOptionsModal } from "../run-with-options-modal";
import { RunLaunchRecovery } from "../run-launch-recovery";
import { NewScheduleModal } from "../new-schedule-modal";
import type { PackageActionsDropdownProps } from "./use-package-actions";
import { deedInSpaces, deedOfAction, spaceDeedLabels, type SpaceDeed } from "../space-deed";

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

const NO_SPACES: readonly string[] = [];

export interface AgentActionsProps {
  packageId: string;
  isHistoricalVersion: boolean;
  downloadVersion: string | undefined;
  downloadPackage: (version: string, spaceId?: string) => void;
  /** Export the agent + transitive deps as a single .afps-bundle, from `spaceId` when given. */
  downloadBundle?: (version?: string, spaceId?: string) => void;
  onCreateVersion: () => void;
  /** Set while the page holds unsaved definition edits a version or run would not carry. */
  unsavedReason?: string;
  /** The published version the catalogue sheet opens on (`catalogueVersionFor`). */
  catalogueVersion?: string;
}

/**
 * The agent page's Actions menu and the dialogs its deeds open. With a space selected every deed
 * acts there. In « Tous les espaces », run and schedule dialogs enter the chosen space.
 * Forks and deletions send the chosen space with their request. The bundle can be read
 * from any active placement. The menu is available once the agent detail has loaded.
 */
export function useAgentActions({
  packageId,
  isHistoricalVersion,
  downloadVersion,
  downloadPackage,
  downloadBundle,
  onCreateVersion,
  unsavedReason,
  catalogueVersion,
}: AgentActionsProps) {
  const { t } = useTranslation(["agents", "common"]);
  const { on: overview } = useOverviewMode();
  const { can } = usePermissions();
  const spaceLabelOf = useSpaceLabelOf();
  const { data: detail } = usePackageDetail("agent", packageId);
  const spaceIds = detail?.space_ids ?? NO_SPACES;
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

  const runSpace = useAgentSpaceAction(packageId, "agents:run", spaceIds, {
    preferWorkingSpace: false,
  });
  const scheduleSpace = useAgentSpaceAction(packageId, "schedules:write", spaceIds, {
    preferWorkingSpace: false,
  });

  // « Supprimer les runs » deletes every run of the agent in one space, which the route asks of
  // `runs:delete` and `runs:read-all` there. In the mode: among its readable placements, once
  // it ran somewhere (a space with none answers `deleted_count: 0`); a space with a run in flight
  // is not offered.
  const deleters = useSpacesFor({ permission: "runs:delete" }, detail?.read_space_ids ?? NO_SPACES);
  const allReaders = useSpacesFor(
    { permission: "runs:read-all" },
    detail?.read_space_ids ?? NO_SPACES,
  );
  const latestAcross = useAgentLatestRunAcross(packageId, { enabled: overview });
  const inFlightAcross = useAgentRunsInFlightAcross(packageId, { enabled: overview });
  const ran = overview ? (latestAcross.data?.data.length ?? 0) > 0 : !!detail?.last_run;
  const runSpaces = ran
    ? deleters.targets.filter((space) =>
        allReaders.targets.some((reader) => reader.id === space.id),
      )
    : [];
  const busy = (spaceId: string) =>
    overview ? inFlightAcross.busyIn(spaceId) : (detail?.running_runs ?? 0) > 0;
  const freeRunSpaces = runSpaces.filter((space) => !busy(space.id));
  const clearRunsLabels = spaceDeedLabels(t, "spaceChoice.clearRuns", "spaceChoice.clearRunsIn");
  const askClearRuns = (spaceId: string) => setConfirming({ kind: "clearRuns", spaceId });
  const clearRuns: SpaceDeed =
    runSpaces.length > 0 && freeRunSpaces.length === 0
      ? { ...deedInSpaces(overview, runSpaces, clearRunsLabels, askClearRuns), disabled: true }
      : deedInSpaces(overview, freeRunSpaces, clearRunsLabels, askClearRuns);

  // « Supprimer les mémoires » deletes the archived memories of one space: among those that grant
  // it and hold some, each row naming its space in the mode.
  const { data: memories } = useAgentMemories(packageId, { spanning: overview });
  const memoryDeleters = useSpacesFor({ permission: "persistence:delete" });
  const memorySpaces = memoryDeleters.targets.filter((space) =>
    (memories ?? []).some((memory) => !overview || memory.spaceId === space.id),
  );
  const clearMemories = deedInSpaces(
    overview,
    memorySpaces,
    spaceDeedLabels(t, "spaceChoice.clearMemories", "spaceChoice.clearMemoriesIn"),
    (spaceId) => setConfirming({ kind: "clearMemories", spaceId }),
  );

  // « Télécharger le bundle »: the export answers in a space where the agent is active, the same
  // bundle from any of them: the working space when it is one, else the first that reads agents.
  const bundleReaders = useSpacesFor({ permission: "agents:read" }, spaceIds);
  const bundleFrom = bundleReaders.anyOf;
  const bundle: SpaceDeed = {
    offered:
      !!downloadBundle && (overview ? !!bundleFrom : bundleReaders.offered && !!detail?.active),
    onSelect: () => downloadBundle?.(downloadVersion, bundleFrom),
  };

  if (!detail) return { dropdown: undefined, dialogs: null };

  // Not the full run verdict: the options modal picks the model and the version.
  const refusal = agentLaunchRefusal(detail, { spanning: overview });
  const runBlockedReason = refusal ? t(refusal) : unsavedReason;
  const canRunWithOptions = can("agents:run") && !runBlockedReason;
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

  const dropdown: PackageActionsDropdownProps = {
    packageId,
    type: "agent",
    detail,
    isHistoricalVersion,
    downloadVersion,
    onDownload: downloadPackage,
    onCreateVersion,
    createVersionBlockedReason: unsavedReason,
    catalogueVersion,
    agent: {
      runWithOptions: deedOfAction(
        runSpace,
        spaceDeedLabels(t, "spaceChoice.runOptions", "spaceChoice.runOptionsIn"),
        // Opened once in the space: the modal reads the agent of the space entered.
        () => setRunOptionsOpen(true),
      ),
      runBlockedReason,
      addSchedule: {
        ...deedOfAction(
          scheduleSpace,
          spaceDeedLabels(t, "spaceChoice.schedule", "spaceChoice.scheduleIn"),
          () => setNewScheduleOpen(true),
        ),
        // A schedule cannot carry a file input.
        offered: scheduleSpace.offered && !schemaHasFileFields(detail.input?.schema),
      },
      bundle,
      clearRuns,
      clearMemories,
      onDeleteAgent: () => setConfirming({ kind: "deleteAgent", spaceId: null }),
    },
  };

  const dialogs = (
    <>
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

  return { dropdown, dialogs };
}
