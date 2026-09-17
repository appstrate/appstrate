// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { schemaHasFileFields } from "@appstrate/core/form";
import { getErrorMessage } from "@appstrate/core/errors";
import { usePackageDetail } from "../../hooks/use-packages";
import { useRuns } from "../../hooks/use-runs";
import { useAgentMemories } from "../../hooks/use-persistence";
import {
  useDeleteAgent,
  useDeleteAgentRuns,
  useDeleteAllMemories,
  useRunAgent,
} from "../../hooks/use-mutations";
import { useSetPackageActive } from "../../hooks/use-library";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { PackageActionsDropdown } from "./package-actions-dropdown";
import { ConfirmModal } from "../confirm-modal";
import { RunWithOptionsModal } from "../run-with-options-modal";

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
  const navigate = useNavigate();
  const { data: detail } = usePackageDetail("agent", packageId);
  const { data: runs } = useRuns(packageId);
  const { data: memories } = useAgentMemories(packageId);
  const deleteAgent = useDeleteAgent();
  const deleteRuns = useDeleteAgentRuns(packageId);
  const deleteAllMemories = useDeleteAllMemories(packageId);
  const setActive = useSetPackageActive();
  const runAgent = useRunAgent(packageId);
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
  // Two refusals the launcher would otherwise discover by round trip. Being
  // switched off HERE comes first, because the cure is one item away in this
  // very menu ("Activer dans cet espace") while publishing is somebody else's
  // act. The second is a package with nothing published whose working copy is
  // not this caller's: a launch that names no version gets `404
  // no_published_version`.
  const runBlockedReason = !activeHere
    ? t("detail.titleNotActive")
    : detail.definition === "draft" && !detail.home_writable
      ? t("detail.titleNeverPublished")
      : undefined;

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
        runningRuns={detail.running_runs}
        hasRuns={!!runs && runs.length > 0}
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
          setActive.mutate(
            { spaceId: currentSpaceId, packageId, active: true },
            // The refusal has to be said: the optimistic cache write makes the
            // switch look taken, and the rollback that follows is silent.
            { onError: (err) => toast.error(getErrorMessage(err) || t("error.generic")) },
          );
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
        onAddSchedule={() => navigate("/schedules/new")}
        onDeleteMemories={() =>
          setConfirmState({
            type: "clearMemories",
            label: t("detail.clearMemoriesConfirm"),
          })
        }
        onRunWithOptions={() => setRunOptionsOpen(true)}
        {...(runBlockedReason ? { runBlockedReason } : {})}
      />
      <RunWithOptionsModal
        open={runOptionsOpen}
        onClose={() => setRunOptionsOpen(false)}
        agent={detail}
        isPending={runAgent.isPending}
        onSubmit={({ input, version, overrides, dependencyOverrides }) => {
          // Map the modal payload onto the run API body. `version` rides the
          // `?version=` query and is always an explicit pick here — the modal
          // seeds it with the same default plain "Lancer" would send. The
          // overrides panel already emits the server's wire values (a proxy
          // pick of "none" means no proxy), so the value passes through as-is.
          const proxy = overrides.proxy_id_override;
          runAgent.mutate(
            {
              ...(Object.keys(input).length > 0 ? { input } : {}),
              version,
              ...(overrides.model_id_override ? { modelId: overrides.model_id_override } : {}),
              ...(overrides.generation_config_override
                ? { generation: overrides.generation_config_override }
                : {}),
              ...(proxy ? { proxyId: proxy } : {}),
              ...(overrides.connection_overrides
                ? { connectionOverrides: overrides.connection_overrides }
                : {}),
              ...(Object.keys(dependencyOverrides).length > 0 ? { dependencyOverrides } : {}),
            },
            { onSuccess: () => setRunOptionsOpen(false) },
          );
        }}
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
