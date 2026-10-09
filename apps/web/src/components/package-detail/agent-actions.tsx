// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { schemaHasFileFields } from "@appstrate/core/form";
import { usePackageDetail } from "../../hooks/use-packages";
import { agentLaunchRefusal } from "../../hooks/use-agent-readiness";
import { useAgentMemories } from "../../hooks/use-persistence";
import {
  useDeleteAgent,
  useDeleteAgentRuns,
  useDeleteAllMemories,
  useRunLauncher,
} from "../../hooks/use-mutations";
import { useSetPackageActive } from "../../hooks/use-library";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { PackageActionsDropdown } from "./package-actions-dropdown";
import { ConfirmModal } from "../confirm-modal";
import { RunWithOptionsModal } from "../run-with-options-modal";
import { RunLaunchRecovery } from "../run-launch-recovery";
import { launchFromOptions } from "../../lib/run-launch";
import { useModalParam } from "../../hooks/use-modal-param";
import { NEW_SCHEDULE_PARAM } from "../new-schedule-modal";

export function AgentActions({
  packageId,
  isOwned,
  isHistoricalVersion,
  downloadVersion,
  downloadPackage,
  downloadBundle,
  onCreateVersion,
  onFork,
}: {
  packageId: string;
  isOwned: boolean;
  isHistoricalVersion: boolean;
  downloadVersion: string | undefined;
  downloadPackage: (v: string) => void;
  /** Export the agent + transitive deps as a single .afps-bundle. */
  downloadBundle?: (v?: string) => void;
  onCreateVersion: () => void;
  onFork?: () => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const newSchedule = useModalParam(NEW_SCHEDULE_PARAM);
  const { data: detail } = usePackageDetail("agent", packageId);
  const { data: memories } = useAgentMemories(packageId);
  const deleteAgent = useDeleteAgent();
  const deleteRuns = useDeleteAgentRuns(packageId);
  const deleteAllMemories = useDeleteAllMemories(packageId);
  const setActive = useSetPackageActive();
  const launcher = useRunLauncher(packageId);
  const currentSpaceId = useCurrentSpaceId();

  const [confirmState, setConfirmState] = useState<{
    type: "deleteAgent" | "clearRuns" | "clearMemories" | "deactivateAgent";
    label: string;
  } | null>(null);
  const [runOptionsOpen, setRunOptionsOpen] = useState(false);

  if (!detail) return null;

  const hasFileInput = schemaHasFileFields(detail.input?.schema);
  // Whether the agent RUNS in the space this page is read from, straight off
  // the response this menu already has. `GET /api/packages/agents/{id}` answers
  // it for the same space it resolved everything else in, so the menu and the
  // rest of the page cannot disagree — and a caller the library stays silent
  // about (a `runner` holds `agents:run` and no `agents:read`, so the space
  // library lists no agents at all) still gets a verdict here.
  const activeHere = detail.active;
  // Not the full run verdict: the options modal picks the model and the version.
  const refusal = agentLaunchRefusal(detail);
  const runBlockedReason = refusal ? t(refusal) : undefined;

  const handleConfirm = () => {
    if (!confirmState) return;
    const onSuccess = () => setConfirmState(null);
    switch (confirmState.type) {
      case "deleteAgent":
        deleteAgent.mutate(detail.id, { onSuccess });
        break;
      case "clearRuns":
        deleteRuns.mutate(undefined, { onSuccess });
        break;
      case "clearMemories":
        deleteAllMemories.mutate(undefined, { onSuccess });
        break;
      case "deactivateAgent":
        if (!currentSpaceId) return;
        setActive.mutate({ spaceId: currentSpaceId, packageId, active: false }, { onSuccess });
        break;
    }
  };

  return (
    <>
      <PackageActionsDropdown
        packageId={packageId}
        type="agent"
        isOwned={isOwned}
        isBuiltIn={detail.source === "system"}
        isHistoricalVersion={isHistoricalVersion}
        homeSpaceId={detail.home_space_id}
        homeWritable={detail.home_writable}
        homeDeletable={detail.home_deletable}
        homeShareable={detail.home_shareable}
        downloadVersion={downloadVersion}
        onDownload={downloadPackage}
        onDownloadBundle={downloadBundle}
        hasPublishedVersion={(detail.version_count ?? 0) > 0}
        isActiveHere={activeHere}
        onCreateVersion={onCreateVersion}
        onFork={onFork}
        // The definition is edited in Paramètres › Définition.
        showEdit={false}
        runningRuns={detail.running_runs}
        // Under the same run visibility as the list the item would clear.
        hasRuns={detail.last_run !== null}
        hasMemories={!!memories && memories.length > 0}
        hasFileInput={!!hasFileInput}
        onDeleteAgent={() =>
          setConfirmState({
            type: "deleteAgent",
            label: t("detail.deleteConfirm", { name: detail.display_name }),
          })
        }
        // The agents index lists what this space READS — an agent placed here
        // and switched off is on it, and running it needs the switch on. This is
        // the door: the same `POST /api/spaces/{spaceId}/packages` the library
        // calls, reached from the page the index links to. A SYSTEM agent is
        // not exempt: "active here" has one definition for the four families,
        // the row wins over the platform's default, and switching one off per
        // space is the sticky opt-out the run gate then honours.
        canActivate={!activeHere}
        onActivate={() => {
          if (!currentSpaceId) return;
          setActive.mutate({ spaceId: currentSpaceId, packageId, active: true });
        }}
        canDeactivate={activeHere}
        onDeactivate={() =>
          setConfirmState({
            type: "deactivateAgent",
            label: t("packages.deactivateConfirm", {
              name: detail.display_name,
              ns: "settings",
            }),
          })
        }
        activationPending={setActive.isPending}
        onDeleteRuns={() =>
          setConfirmState({
            type: "clearRuns",
            label: t("detail.clearRunsConfirm"),
          })
        }
        onAddSchedule={() => newSchedule.open(packageId)}
        onDeleteMemories={() =>
          setConfirmState({
            type: "clearMemories",
            label: t("detail.clearMemoriesConfirm"),
          })
        }
        onRunWithOptions={() => setRunOptionsOpen(true)}
        labelledTrigger
        {...(runBlockedReason ? { runBlockedReason } : {})}
      />
      <RunWithOptionsModal
        open={runOptionsOpen}
        onClose={() => setRunOptionsOpen(false)}
        agent={detail}
        isPending={launcher.isPending}
        onSubmit={(submit) =>
          launcher.launch(launchFromOptions(submit), () => setRunOptionsOpen(false))
        }
      />
      <RunLaunchRecovery
        launcher={launcher}
        packageId={packageId}
        integrationEntries={detail.dependencies.integrations}
      />
      <ConfirmModal
        open={confirmState !== null}
        onClose={() => setConfirmState(null)}
        onConfirm={handleConfirm}
        title={t("btn.confirm", { ns: "common" })}
        description={confirmState?.label ?? ""}
        confirmLabel={
          confirmState?.type === "deactivateAgent"
            ? t("packages.deactivate", { ns: "settings" })
            : undefined
        }
        isPending={
          deleteAgent.isPending ||
          deleteRuns.isPending ||
          deleteAllMemories.isPending ||
          setActive.isPending
        }
      />
    </>
  );
}
