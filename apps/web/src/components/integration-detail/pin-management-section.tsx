// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@appstrate/ui/components/table";
import { SettingsHeading } from "../settings/settings-heading";
import {
  useIntegrationPins,
  useIntegrationConnections,
  type IntegrationConnection,
  useAgentsConsumingIntegration,
  useUpsertIntegrationPin,
  useDeleteIntegrationPin,
} from "../../hooks/use-integrations";
import { connectionOptionLabel, type ConnectionSet } from "../../lib/connection-set";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { isSharedInSpace } from "../integration-connect/connection-ownership";
import { ConnectionOptionLabel, ConnectionSetChecklist } from "./connection-set-checklist";

/**
 * Per-agent pins: one per (agent, integration), holding the whole bound SET, replaced on
 * write. With an org default in place, these are per-agent EXCEPTIONS. An empty set pins
 * "no connection"; whether that blocks a run is the running version's `required` to say.
 */
export function PinManagementSection({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["settings", "agents"]);
  const { data: pins } = useIntegrationPins(packageId);
  const { data: connections } = useIntegrationConnections(packageId);
  const spaceId = useCurrentSpaceId();
  const { data: consumingAgents } = useAgentsConsumingIntegration(packageId);
  const deletePin = useDeleteIntegrationPin();

  const [adding, setAdding] = useState(false);

  const pinnableConnections = (connections ?? []).filter((c) => isSharedInSpace(c, spaceId));

  // Lookup helpers for the table
  const agentDisplayName = (id: string): string =>
    consumingAgents?.find((a) => a.agent_package_id === id)?.display_name ?? id;

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

      {/* Existing pins */}
      {(pins ?? []).length > 0 ? (
        <div className="mb-4 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("integration.admin.pinManagement.colAgent")}</TableHead>
                <TableHead>{t("integration.admin.pinManagement.colConnections")}</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(pins ?? []).map((p) => (
                <TableRow key={p.agent_package_id} data-testid={`pin-row-${p.agent_package_id}`}>
                  <TableCell>{agentDisplayName(p.agent_package_id)}</TableCell>
                  <TableCell>
                    {p.connection_ids.length === 0 && (
                      <span className="text-muted-foreground">
                        {t("agents:detail.integrationMemberPicker.none")}
                      </span>
                    )}
                    {p.connection_ids.map((id, i) => {
                      const c = pinnableConnections.find((x) => x.id === id);
                      return (
                        <span key={id}>
                          {i > 0 && " · "}
                          {c ? (
                            connectionOptionLabel(c)
                          ) : connections === undefined ? null : (
                            // No longer shared or deleted: every run of this agent is refused.
                            <span className="text-warning">
                              {t("integration.admin.unavailableConnection")}
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      disabled={deletePin.isPending}
                      onClick={() =>
                        deletePin.mutate({
                          params: { path: { packageId, agentPackageId: p.agent_package_id } },
                        })
                      }
                      title={t("integration.admin.pinManagement.delete")}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="text-muted-foreground mb-3 text-xs italic">
          {t("integration.admin.pinManagement.empty")}
        </p>
      )}

      {/* Add new pin — "no connection" needs no shared connection. */}
      {pinnableAgents.length === 0 ? (
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
        <Select value={newAgent} onValueChange={setNewAgent}>
          <SelectTrigger id="pin-add-agent" data-testid="pin-add-agent">
            <SelectValue placeholder={t("integration.admin.pinManagement.colAgent")} />
          </SelectTrigger>
          <SelectContent>
            {agents.map((a) => (
              <SelectItem key={a.agent_package_id} value={a.agent_package_id}>
                {a.display_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="min-w-[12rem] flex-1">
        <p id="pin-add-connections-label" className="mb-2 block text-sm font-medium">
          {t("integration.admin.pinManagement.colConnections")}
        </p>
        {connections.length === 0 && (
          <p className="text-muted-foreground mb-1 text-xs italic">
            {t("integration.admin.pinManagement.noPinnableConnections")}
          </p>
        )}
        <ConnectionSetChecklist
          options={connections.map((c) => ({
            id: c.id,
            label: <ConnectionOptionLabel connection={c} />,
          }))}
          value={newConnectionIds}
          onChange={setNewConnectionIds}
          idPrefix="pin-add-connection"
          labelledBy="pin-add-connections-label"
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
