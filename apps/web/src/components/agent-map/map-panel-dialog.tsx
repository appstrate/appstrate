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
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Modal } from "../modal";
import { Spinner } from "../spinner";
import { AgentConnectionsSection } from "../package-detail/agent-connections-section";
import { AgentSchedulesTab, AgentMemoryTab } from "../package-detail/agent-tabs";
import { ModelSection } from "../package-detail/agent-configuration-tab";
import { ModelFormModal } from "../model-form-modal";
import { usePackageDetail } from "../../hooks/use-packages";
import { useModels, useModelFormHandler } from "../../hooks/use-models";

/** Which existing panel to show. */
export type MapPanelKind = "connections" | "schedules" | "memory" | "model";

const TITLE_KEY: Record<MapPanelKind, string> = {
  connections: "detail.tabConnections",
  schedules: "detail.tabSchedules",
  memory: "detail.tabMemory",
  model: "map.model",
};

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
  // Only the connections panel needs the detail DTO; fetching it for every kind
  // costs nothing extra (the page already holds it in cache).
  const { data: detail } = usePackageDetail("agent", kind ? packageId : undefined);

  if (!kind) return null;

  return (
    <Modal open onClose={onClose} title={t(TITLE_KEY[kind])} className="sm:max-w-3xl">
      <div className="max-h-[70vh] overflow-y-auto">
        {kind === "schedules" && <AgentSchedulesTab packageId={packageId} />}
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
