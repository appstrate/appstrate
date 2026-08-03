// SPDX-License-Identifier: Apache-2.0

/**
 * The full list behind the header's "N to fix" counter.
 *
 * The counter used to open the Connections panel, which only knows about
 * integrations: a map reporting five problems answered with two rows, and a
 * missing skill had nowhere to be seen at all. The number and its destination
 * were describing different sets.
 *
 * So the counter opens the diagnostics themselves — every one the readiness gate
 * raised, verbatim, each with the way to go fix it. Routing is by `node_id`,
 * which the server already assigns, so a new readiness check lands on the right
 * destination without a change here.
 */

import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Modal } from "../../components/modal";
import type { AgentMapDiagnostic } from "./use-agent-map";
import type { MapEditKind } from "./map-edit-dialog";
import type { MapPanelKind } from "./map-panel-dialog";

type Destination = { slot: "edit"; kind: MapEditKind } | { slot: "panel"; kind: MapPanelKind };

/**
 * Where a diagnostic gets fixed: one destination per card, the same one its rows
 * open.
 *
 * `integration_not_active` used to be special-cased to the integrations editor,
 * because the Connections panel could only state the blockage. The panel can now
 * activate in place, so the exception is gone — two ways in for two problems on
 * the same card only invited the question "what is the difference?", and the
 * honest answer had become "none".
 */
const BY_NODE: Record<string, Destination> = {
  agent: { slot: "edit", kind: "prompt" },
  config: { slot: "panel", kind: "config" },
  skills: { slot: "edit", kind: "skills" },
  toolbox: { slot: "panel", kind: "connections" },
  model: { slot: "panel", kind: "model" },
};

function destinationFor(diagnostic: AgentMapDiagnostic): Destination | undefined {
  return diagnostic.node_id ? BY_NODE[diagnostic.node_id] : undefined;
}

export function MapIssuesDialog({
  diagnostics,
  onEdit,
  onPanel,
  onClose,
}: {
  diagnostics: AgentMapDiagnostic[] | null;
  onEdit: (kind: MapEditKind) => void;
  onPanel: (kind: MapPanelKind) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["agents", "agent-map"]);
  if (!diagnostics) return null;

  return (
    <Modal
      open
      onClose={onClose}
      title={t("agent-map:issueCount", { count: diagnostics.length })}
      className="sm:max-w-2xl"
    >
      <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
        {diagnostics.map((d) => {
          const destination = destinationFor(d);
          return (
            <div
              key={`${d.field}:${d.code}`}
              className="border-border flex items-start gap-3 rounded-lg border p-3"
            >
              <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                {d.title && <div className="text-sm font-medium">{d.title}</div>}
                <div className="text-muted-foreground text-xs">{d.message}</div>
              </div>
              {destination && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    // The dialogs are mutually exclusive, so this one steps aside
                    // rather than stacking a second overlay on top of itself.
                    onClose();
                    if (destination.slot === "edit") onEdit(destination.kind);
                    else onPanel(destination.kind);
                  }}
                >
                  {t("agent-map:fixIssue")}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
