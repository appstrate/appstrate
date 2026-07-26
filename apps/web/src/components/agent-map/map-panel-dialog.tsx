// SPDX-License-Identifier: Apache-2.0

/**
 * Opens an existing agent panel in a dialog instead of navigating to its tab.
 *
 * The map is where you were looking; being thrown onto another tab to flip one
 * switch and then having to come back is the wrong trade. These panels are
 * already self-contained components that own their own queries and mutations, so
 * mounting them here is pure wiring — no logic is duplicated, and whatever they
 * gain later shows up here for free.
 *
 * Kept separate from `MapEditDialog`, which drives a draft-then-save cycle over
 * the manifest. These panels save themselves.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Modal } from "../modal";
import { Spinner } from "../spinner";
import { AgentConnectionsSection } from "../package-detail/agent-connections-section";
import { AgentSchedulesTab, AgentMemoryTab } from "../package-detail/agent-tabs";
import { ModelSection } from "../package-detail/agent-configuration-tab";
import { ModelFormModal } from "../model-form-modal";
import { ScheduleForm } from "../schedule-form";
import { usePackageDetail } from "../../hooks/use-packages";
import { useModels, useModelFormHandler } from "../../hooks/use-models";
import { useCreateSchedule, useScheduleFormDeps, useSchedules } from "../../hooks/use-schedules";
import { agentMapQueryKeyPrefix } from "../../hooks/use-agent-map";

/** Which existing panel to show. */
export type MapPanelKind = "connections" | "schedules" | "memory" | "model";

const TITLE_KEY: Record<MapPanelKind, string> = {
  connections: "detail.tabConnections",
  schedules: "detail.tabSchedules",
  memory: "detail.tabMemory",
  model: "map.model",
};

/**
 * The agent's schedules, and creating one WITHOUT leaving for `/schedules/new`.
 *
 * That page defaults its agent selector to the first agent in the list, which is
 * almost never the one you were looking at — so creating a schedule from an
 * agent's page meant re-picking the agent by hand. Here the agent is pinned: the
 * selector is handed a single option, so `ScheduleForm` (unchanged) cannot offer
 * anything else, and on success we return to the list instead of navigating away.
 */
function SchedulesPanel({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["agents", "common"]);
  const [creating, setCreating] = useState(false);
  const { data: detail } = usePackageDetail("agent", packageId);
  const { data: schedules } = useSchedules(packageId);
  const deps = useScheduleFormDeps(packageId);
  const createSchedule = useCreateSchedule(packageId);

  if (!creating) {
    // The empty state already carries an "add" button (wired through
    // `onCreate`), so only add ours when the list is non-empty — otherwise the
    // panel shows two of them.
    const hasSchedules = (schedules?.length ?? 0) > 0;
    return (
      <div className="space-y-3">
        <AgentSchedulesTab packageId={packageId} onCreate={() => setCreating(true)} />
        {hasSchedules && (
          <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 size-3.5" />
            {t("common:btn.add")}
          </Button>
        )}
      </div>
    );
  }

  return (
    <ScheduleForm
      mode="create"
      // One option only — this agent. The map is agent-scoped, so letting the
      // form retarget another agent would be a trap, not a feature.
      agents={[{ id: packageId, displayName: detail?.display_name ?? packageId }]}
      selectedAgentId={packageId}
      onAgentChange={() => undefined}
      inputSchema={deps?.inputSchema}
      configSchema={deps?.configSchema}
      persistedConfig={deps?.persistedConfig ?? {}}
      persistedModelId={deps?.persistedModelId ?? null}
      persistedProxyId={deps?.persistedProxyId ?? null}
      persistedVersion={deps?.persistedVersion ?? null}
      packageId={packageId}
      agentIntegrations={deps?.agentIntegrations ?? []}
      blockedMessage={deps?.hasFileInputs ? t("agents:schedule.fileInputBlocked") : undefined}
      isPending={createSchedule.isPending}
      onSubmit={(data) => createSchedule.mutate(data, { onSuccess: () => setCreating(false) })}
      onCancel={() => setCreating(false)}
    />
  );
}

/**
 * The model picker, plus a way out when there is nothing to pick.
 *
 * `ModelSection` renders `null` when the organization has no model at all — which
 * is precisely the case the map's model card flags — so on its own the dialog came
 * up EMPTY. Pairing it with the existing `ModelFormModal` turns the dead end into
 * the fix: add a model here, and the card resolves without leaving the map.
 */
function ModelPanel({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["agents", "settings"]);
  const { data: orgModels } = useModels();
  const [adding, setAdding] = useState(false);
  const { isPending, onSubmit } = useModelFormHandler({ onSuccess: () => setAdding(false) });
  const hasModels = (orgModels?.length ?? 0) > 0;

  return (
    <div className="space-y-3">
      {hasModels ? (
        <ModelSection packageId={packageId} />
      ) : (
        <p className="text-muted-foreground text-sm">{t("settings:models.empty")}</p>
      )}
      <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
        <Plus className="mr-1.5 size-3.5" />
        {t("settings:models.add")}
      </Button>
      <ModelFormModal
        open={adding}
        onClose={() => setAdding(false)}
        model={null}
        isPending={isPending}
        onSubmit={onSubmit}
      />
    </div>
  );
}

export function MapPanelDialog({
  kind,
  packageId,
  onClose,
}: {
  kind: MapPanelKind | null;
  packageId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("agents");
  const qc = useQueryClient();
  // Only the connections panel needs the detail DTO; fetching it for every kind
  // costs nothing extra (the page already holds it in cache).
  const { data: detail } = usePackageDetail("agent", kind ? packageId : undefined);

  if (!kind) return null;

  // Every panel here can change something the map projects — a model added or
  // switched, a connection made, a schedule created, memory granted — and none of
  // their mutations know about the map's query. Refreshing once on the way out
  // covers all of them, instead of each panel remembering to.
  const closeAndRefresh = () => {
    void qc.invalidateQueries({ queryKey: agentMapQueryKeyPrefix });
    onClose();
  };

  return (
    <Modal open onClose={closeAndRefresh} title={t(TITLE_KEY[kind])} className="sm:max-w-3xl">
      <div className="max-h-[70vh] overflow-y-auto">
        {kind === "schedules" && <SchedulesPanel packageId={packageId} />}
        {kind === "memory" && <AgentMemoryTab packageId={packageId} />}
        {kind === "model" && <ModelPanel packageId={packageId} />}
        {kind === "connections" &&
          (detail ? (
            <AgentConnectionsSection packageId={packageId} detail={detail} />
          ) : (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ))}
      </div>
    </Modal>
  );
}
