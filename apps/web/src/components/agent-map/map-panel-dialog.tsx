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

import { useTranslation } from "react-i18next";
import { Modal } from "../modal";
import { Spinner } from "../spinner";
import { AgentConnectionsSection } from "../package-detail/agent-connections-section";
import { AgentSchedulesTab, AgentMemoryTab } from "../package-detail/agent-tabs";
import { ModelSection } from "../package-detail/agent-configuration-tab";
import { usePackageDetail } from "../../hooks/use-packages";

/** Which existing panel to show. */
export type MapPanelKind = "connections" | "schedules" | "memory" | "model";

const TITLE_KEY: Record<MapPanelKind, string> = {
  connections: "detail.tabConnections",
  schedules: "detail.tabSchedules",
  memory: "detail.tabMemory",
  model: "map.model",
};

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
        {kind === "model" && <ModelSection packageId={packageId} />}
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
