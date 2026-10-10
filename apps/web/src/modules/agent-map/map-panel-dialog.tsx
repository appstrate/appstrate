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
import { Modal } from "../../components/modal";
import { Spinner } from "../../components/spinner";
import { AgentConnectionsSection } from "../../components/package-detail/agent-connections-section";
import { AgentMemoryTab } from "../../components/package-detail/agent-tabs";
import {
  InputSettingsSection,
  ModelSection,
  ProxySection,
} from "../../components/package-detail/agent-configuration-tab";
import { asJSONSchemaObject } from "@appstrate/core/form";
import { ModelFormModal } from "../../components/model-form-modal";
import { NewScheduleForm } from "../../components/new-schedule-modal";
import { usePackageDetail } from "../../hooks/use-packages";
import { useModels, useModelFormHandler } from "../../hooks/use-models";
import { agentMapQueryKeyPrefix } from "./use-agent-map";

/** Which existing panel to show. */
export type MapPanelKind = "connections" | "schedules" | "memory" | "model" | "proxy" | "config";

const TITLE_KEY: Record<MapPanelKind, string> = {
  connections: "detail.tabConnections",
  schedules: "schedule.titleNew",
  memory: "detail.tabMemory",
  model: "agent-map:model",
  proxy: "agent-map:proxy",
  config: "agent-map:editConfig",
};

/**
 * Creating a schedule from the map: the shared new-schedule form, its agent
 * fixed to the one the map shows, opened straight away (the card that opened
 * this dialog already lists the agent's schedules).
 */
function NewSchedulePanel({ packageId, onDone }: { packageId: string; onDone: () => void }) {
  return (
    <NewScheduleForm initialAgentId={packageId} fixedAgent onCreated={onDone} onCancel={onDone} />
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
  const { t } = useTranslation(["agents", "agent-map", "settings"]);
  const { data: orgModels } = useModels();
  const [adding, setAdding] = useState(false);
  const { isPending, onSubmit } = useModelFormHandler({
    onSuccess: () => setAdding(false),
  });
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

/**
 * The per-installation settings form.
 *
 * `InputSettingsSection` renders the same form as the configuration tab, and
 * an agent with no settings has an empty card that should say so rather than
 * open a blank dialog.
 */
function ConfigPanel({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["agents", "agent-map"]);
  const { data: detail } = usePackageDetail("agent", packageId);
  const schema = detail?.input?.schema ? asJSONSchemaObject(detail.input.schema) : null;

  if (!detail) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }
  if (!schema?.properties || Object.keys(schema.properties).length === 0) {
    return <p className="text-muted-foreground text-sm">{t("agent-map:emptyConfig")}</p>;
  }
  return (
    <InputSettingsSection
      packageId={packageId}
      wrapper={{ schema }}
      initialValues={detail.input.values}
      initialLocked={detail.input.locked_fields}
      isHistorical={false}
    />
  );
}

export function MapPanelDialog({
  kind: requested,
  packageId,
  onClose,
}: {
  /** The `?mapPanel=` value as it came: one that names no panel opens nothing. */
  kind: string | null;
  packageId: string;
  onClose: () => void;
}) {
  const kind = requested !== null && requested in TITLE_KEY ? (requested as MapPanelKind) : null;
  const { t } = useTranslation(["agents", "agent-map"]);
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
        {kind === "schedules" && (
          <NewSchedulePanel packageId={packageId} onDone={closeAndRefresh} />
        )}
        {kind === "memory" && <AgentMemoryTab packageId={packageId} />}
        {kind === "config" && <ConfigPanel packageId={packageId} />}
        {kind === "model" && <ModelPanel packageId={packageId} />}
        {kind === "proxy" && <ProxySection packageId={packageId} />}
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
