// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Label } from "@appstrate/ui/components/label";
import { OptionSelect } from "@appstrate/ui/components/select";
import { SettingsHeading } from "../settings/settings-heading";
import { ConfirmModal } from "../confirm-modal";
import { DataTable } from "../data-table";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import type { IntegrationPin } from "@appstrate/shared-types";
import { usePinColumns } from "./pin-columns";
import {
  useIntegrationPins,
  useIntegrationConnections,
  type IntegrationConnection,
  useAgentsConsumingIntegration,
  useUpsertIntegrationPin,
  useDeleteIntegrationPin,
} from "../../hooks/use-integrations";
import type { ConnectionSet } from "../../lib/connection-set";
import { ConnectionSetPicker } from "../integration-connect/connection-choice-menu";
import { connectionSetOption } from "../integration-connect/connection-set-option";

/**
 * Per-agent pins: one per (agent, integration), holding the whole bound SET, replaced on
 * write. With an org default in place, these are per-agent EXCEPTIONS. An empty set pins
 * "no connection"; whether that blocks a run is the running version's `required` to say.
 */
export function PinManagementSection({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["settings", "agents"]);
  const { data: pins, isLoading: pinsLoading, error: pinsError } = useIntegrationPins(packageId);
  const { data: connections, isLoading: connectionsLoading } = useIntegrationConnections(packageId);
  const { data: consumingAgents, isLoading: agentsLoading } =
    useAgentsConsumingIntegration(packageId);
  const deletePin = useDeleteIntegrationPin();

  const [adding, setAdding] = useState(false);
  const [toDelete, setToDelete] = useState<IntegrationPin | null>(null);

  const pinnableConnections = (connections ?? []).filter((c) => c.shared_here);

  // Lookup helpers for the table
  const agentDisplayName = (id: string) =>
    consumingAgents?.find((a) => a.agent_package_id === id)?.display_name ?? id;

  const columns = usePinColumns({
    agentName: (pin) => agentDisplayName(pin.agent_package_id),
    pinnable: pinnableConnections,
    connections,
    isDeleting: (pin) => deletePin.isPending && toDelete?.agent_package_id === pin.agent_package_id,
    onDelete: setToDelete,
  });

  // Only include agents not already pinned.
  const alreadyPinnedAgentIds = new Set(
    (pins ?? [])
      .filter((p) => p.integration_package_id === packageId)
      .map((p) => p.agent_package_id),
  );
  const pinnableAgents = (consumingAgents ?? []).filter(
    (a) => !alreadyPinnedAgentIds.has(a.agent_package_id),
  );

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
          label={t("integration.admin.exceptions.title")}
          columns={columns}
          rows={pins ?? []}
          rowKey={(pin) => pin.agent_package_id}
          isLoading={pinsLoading || agentsLoading}
          failure={pinsError}
          empty={
            <p className="text-muted-foreground px-3 py-3 text-xs italic">
              {t("integration.admin.pinManagement.empty")}
            </p>
          }
        />
      </div>

      {/* Add new pin — "no connection" needs no shared connection. */}
      {agentsLoading || connectionsLoading || pinsLoading ? (
        <Skeleton className="h-8 w-32" />
      ) : pinnableAgents.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">
          {t("integration.admin.pinManagement.noConsumingAgents")}
        </p>
      ) : !adding ? (
        <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
          {t("integration.admin.pinManagement.add")}
        </Button>
      ) : (
        <NewPinForm
          packageId={packageId}
          agents={pinnableAgents}
          connections={pinnableConnections}
          onDone={() => setAdding(false)}
        />
      )}

      <ConfirmModal
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={() => {
          if (!toDelete) return;
          deletePin.mutate(
            { params: { path: { packageId, agentPackageId: toDelete.agent_package_id } } },
            { onSuccess: () => setToDelete(null) },
          );
        }}
        title={t("integration.admin.pinManagement.delete")}
        description={t("integration.admin.pinManagement.deleteConfirm", {
          agent: toDelete ? agentDisplayName(toDelete.agent_package_id) : "",
        })}
        confirmLabel={t("btn.delete", { ns: "common" })}
        isPending={deletePin.isPending}
      />
    </div>
  );
}

/** Pins one agent to a set of connections, or to none; `onDone` closes it. */
export function NewPinForm({
  packageId,
  agents,
  connections,
  onDone,
}: {
  packageId: string;
  agents: { agent_package_id: string; display_name: string }[];
  connections: IntegrationConnection[];
  onDone: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const upsertPin = useUpsertIntegrationPin();
  const [newAgent, setNewAgent] = useState("");
  const [newConnectionIds, setNewConnectionIds] = useState<ConnectionSet>(null);

  const onSubmitNewPin = () => {
    if (!newAgent || newConnectionIds === null) return;
    upsertPin.mutate(
      {
        params: { path: { packageId, agentPackageId: newAgent } },
        body: { connection_ids: newConnectionIds },
      },
      { onSuccess: onDone },
    );
  };

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-[12rem] flex-1">
        <Label htmlFor="pin-add-agent" className="mb-2 block text-sm">
          {t("integration.admin.pinManagement.colAgent")}
        </Label>
        <OptionSelect
          id="pin-add-agent"
          value={newAgent}
          onValueChange={setNewAgent}
          placeholder={t("integration.admin.pinManagement.colAgent")}
          data-testid="pin-add-agent"
          options={agents.map((a) => ({ value: a.agent_package_id, label: a.display_name }))}
        />
      </div>
      <div className="min-w-[12rem] flex-1">
        <p className="mb-2 block text-sm font-medium">
          {t("integration.admin.pinManagement.colConnections")}
        </p>
        {connections.length === 0 && (
          <p className="text-muted-foreground mb-1 text-xs italic">
            {t("integration.admin.pinManagement.noPinnableConnections")}
          </p>
        )}
        <ConnectionSetPicker
          options={connections.map(connectionSetOption)}
          value={newConnectionIds}
          onChange={setNewConnectionIds}
          testPrefix="pin-add-pick"
          testKey="connections"
          allowNone
          noneHint={t("integration.admin.pinManagement.noneHint")}
        />
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={onSubmitNewPin}
        disabled={!newAgent || newConnectionIds === null || upsertPin.isPending}
        data-testid="pin-add-submit"
      >
        {t("integration.admin.pinManagement.add")}
      </Button>
      <Button variant="ghost" size="sm" disabled={upsertPin.isPending} onClick={onDone}>
        {t("btn.cancel", { ns: "common" })}
      </Button>
    </div>
  );
}
