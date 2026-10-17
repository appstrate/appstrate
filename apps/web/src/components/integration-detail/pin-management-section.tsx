// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { SettingsHeading } from "../settings/settings-heading";
import { DataTable } from "../data-table";
import { usePinColumns } from "./pin-columns";
import { usePinEditor } from "./use-pin-editor";

/**
 * Per-agent pins: one per (agent, integration), holding the whole imposed SET and its mode (runs
 * use exactly that set, or that set plus the user's connections), both replaced on write. With an
 * org default in place, these are per-agent EXCEPTIONS. An empty set pins "no connection"; whether
 * that blocks a run is the running version's `required` to say. The table only reads: a pin is
 * added and edited in one form modal, and deleted only through its confirmation, the same two the
 * agent's Connexions rows open (`usePinEditor`).
 */
export function PinManagementSection({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["settings", "common"]);
  const editor = usePinEditor(packageId);

  const columns = usePinColumns({
    agentName: (pin) => editor.agentName(pin.agent_package_id),
    pinnable: editor.pinnable,
    connections: editor.connections,
    isDeleting: editor.isDeleting,
    onEdit: editor.edit,
    onDelete: editor.remove,
  });

  return (
    <div className="pb-0" data-testid="pin-management-section">
      <SettingsHeading
        level="group"
        title={t("integration.admin.exceptions.title")}
        description={t("integration.admin.exceptions.help")}
      />

      <div className="mb-4">
        <DataTable
          tableId="integration-pins"
          tiered
          label={t("integration.admin.exceptions.title")}
          columns={columns}
          rows={editor.pins ?? []}
          rowKey={(pin) => pin.agent_package_id}
          rowAction={editor.edit}
          isLoading={editor.pinsLoading || editor.agentsLoading}
          failure={editor.pinsError}
          empty={
            <p className="text-muted-foreground px-3 py-3 text-xs italic">
              {t("integration.admin.pinManagement.empty")}
            </p>
          }
        />
      </div>

      {editor.agentsLoading || editor.connectionsLoading || editor.pinsLoading ? (
        <Skeleton className="h-8 w-32" />
      ) : editor.unpinnedAgents.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">
          {t("integration.admin.pinManagement.noConsumingAgents")}
        </p>
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={!editor.add}
          onClick={() => editor.add?.()}
          data-testid="pin-add"
        >
          {t("integration.admin.pinManagement.add")}
        </Button>
      )}

      {editor.dialogs}
    </div>
  );
}
