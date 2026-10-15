// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDeletePackage, usePackageDetail } from "../../hooks/use-packages";
import { agentLaunchRefusal } from "../../hooks/use-agent-readiness";
import { useAgentMemories } from "../../hooks/use-persistence";
import {
  useDeleteAgentRuns,
  useDeleteAllMemories,
  useRunLauncher,
} from "../../hooks/use-mutations";
import { usePermissions } from "../../hooks/use-permissions";
import { PackageActionsDropdown } from "./package-actions-dropdown";
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
}) {
  const { t } = useTranslation(["agents", "common"]);
  const { can } = usePermissions();
  const { data: detail } = usePackageDetail("agent", packageId);
  const { data: memories } = useAgentMemories(packageId);
  const deleteAgent = useDeletePackage("agent");
  const deleteRuns = useDeleteAgentRuns(packageId);
  const deleteAllMemories = useDeleteAllMemories(packageId);
  const launcher = useRunLauncher(packageId);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const [newScheduleOpen, setNewScheduleOpen] = useState(false);
  const [runOptionsOpen, setRunOptionsOpen] = useState(false);

  if (!detail) return null;

  // Not the full run verdict: the options modal picks the model and the version.
  const refusal = agentLaunchRefusal(detail);
  const runBlockedReason = refusal ? t(refusal) : unsavedReason;
  const canRunWithOptions = can("agents:run") && !runBlockedReason;
  const pendingConfirmation =
    deleteAgent.isPending || deleteRuns.isPending || deleteAllMemories.isPending;

  const confirm = () => {
    const onSuccess = () => setConfirming(null);
    if (confirming === "deleteAgent") deleteAgent.mutate(detail.id, { onSuccess });
    else if (confirming === "clearRuns") deleteRuns.mutate(undefined, { onSuccess });
    else if (confirming === "clearMemories") deleteAllMemories.mutate(undefined, { onSuccess });
  };

  return (
    <>
      <PackageActionsDropdown
        packageId={packageId}
        type="agent"
        detail={detail}
        isHistoricalVersion={isHistoricalVersion}
        downloadVersion={downloadVersion}
        onDownload={downloadPackage}
        // Whether the agent RUNS in the space this page is read from, off the response the menu
        // already has: a system agent is no exception, and a caller the library stays silent
        // about (a `runner` holds no `agents:read`) still gets a verdict.
        isActiveHere={detail.active}
        onCreateVersion={onCreateVersion}
        createVersionBlockedReason={unsavedReason}
        agent={{
          hasMemories: !!memories && memories.length > 0,
          onDownloadBundle: downloadBundle,
          onDeleteAgent: () => setConfirming("deleteAgent"),
          onDeleteRuns: () => setConfirming("clearRuns"),
          onDeleteMemories: () => setConfirming("clearMemories"),
          onAddSchedule: () => setNewScheduleOpen(true),
          onRunWithOptions: () => setRunOptionsOpen(true),
          runBlockedReason,
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
        title={confirming ? t(CONFIRM_TEXT[confirming].title) : ""}
        description={
          confirming ? t(CONFIRM_TEXT[confirming].description, { name: detail.display_name }) : ""
        }
        confirmLabel={t("btn.delete", { ns: "common" })}
        isPending={pendingConfirmation}
      />
    </>
  );
}
