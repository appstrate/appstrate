// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Label } from "@appstrate/ui/components/label";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@appstrate/ui/components/table";
import {
  useIntegrationPins,
  useIntegrationConnections,
  useAgentsConsumingIntegration,
  useUpsertIntegrationPin,
  useDeleteIntegrationPin,
} from "../../hooks/use-integrations";
import { connectionOptionLabel } from "../../lib/connection-set";
import { ConnectionSetChecklist } from "./connection-set-checklist";

/**
 * Per-agent pins: one per (agent, integration), holding the whole bound SET, replaced on
 * write. With an org default in place, these are per-agent EXCEPTIONS. An empty set pins
 * "no connection": the agent runs without the integration — refused by the server for an
 * agent that requires it.
 */
export function PinManagementSection({ packageId }: { packageId: string }) {
  const { t } = useTranslation("settings");
  const { data: pins } = useIntegrationPins(packageId);
  const { data: connections } = useIntegrationConnections(packageId);
  const { data: consumingAgents } = useAgentsConsumingIntegration(packageId);
  const upsertPin = useUpsertIntegrationPin();
  const deletePin = useDeleteIntegrationPin();

  const [newAgent, setNewAgent] = useState("");
  const [newConnectionIds, setNewConnectionIds] = useState<string[]>([]);
  const [newPinNone, setNewPinNone] = useState(false);

  const pinnableConnections = (connections ?? []).filter((c) => c.shared_with_org === true);

  // Lookup helpers for the table
  const agentDisplayName = (id: string): string =>
    consumingAgents?.find((a) => a.agent_package_id === id)?.display_name ?? id;

  const canAddPin = !!newAgent && (newPinNone || newConnectionIds.length > 0);

  const onSubmitNewPin = () => {
    if (!canAddPin) return;
    upsertPin.mutate(
      {
        params: { path: { packageId, agentPackageId: newAgent } },
        body: { connection_ids: newPinNone ? [] : newConnectionIds },
      },
      {
        onSuccess: () => {
          setNewAgent("");
          setNewConnectionIds([]);
          setNewPinNone(false);
        },
      },
    );
  };

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
    <div
      className="border-border bg-muted/30 mb-6 rounded-md border p-4"
      data-testid="pin-management-section"
    >
      <div className="mb-3">
        <h3 className="text-sm font-semibold">{t("integration.admin.exceptions.title")}</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          {t("integration.admin.exceptions.help")}
        </p>
      </div>

      {/* Existing pins */}
      {(pins ?? []).length > 0 ? (
        <div className="border-border bg-background mb-3 overflow-hidden rounded-md border">
          <Table className="text-xs">
            <TableHeader className="bg-muted/40">
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-auto px-3 py-2">
                  {t("integration.admin.pinManagement.colAgent")}
                </TableHead>
                <TableHead className="h-auto px-3 py-2">
                  {t("integration.admin.pinManagement.colConnections")}
                </TableHead>
                <TableHead className="h-auto w-12 px-3 py-2" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(pins ?? []).map((p) => (
                <TableRow key={p.agent_package_id} data-testid={`pin-row-${p.agent_package_id}`}>
                  <TableCell className="px-3 py-2">
                    {agentDisplayName(p.agent_package_id)}
                  </TableCell>
                  <TableCell className="px-3 py-2">
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
                            <span className="text-amber-700 dark:text-amber-300">
                              {t("integration.admin.unavailableConnection")}
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </TableCell>
                  <TableCell className="px-3 py-2">
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

      {/* Add new pin */}
      {pinnableConnections.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">
          {t("integration.admin.pinManagement.noPinnableConnections")}
        </p>
      ) : pinnableAgents.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">
          {t("integration.admin.pinManagement.noConsumingAgents")}
        </p>
      ) : (
        <div className="border-border bg-background flex flex-wrap items-end gap-2 rounded-md border p-3">
          <div className="min-w-[12rem] flex-1">
            <Label className="text-muted-foreground mb-1 block text-[0.65rem]">
              {t("integration.admin.pinManagement.colAgent")}
            </Label>
            <select
              className="border-border bg-background w-full rounded border px-2 py-1 text-xs"
              value={newAgent}
              onChange={(e) => setNewAgent(e.target.value)}
              data-testid="pin-add-agent"
            >
              <option value="">—</option>
              {pinnableAgents.map((a) => (
                <option key={a.agent_package_id} value={a.agent_package_id}>
                  {a.display_name}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-[12rem] flex-1">
            <Label className="text-muted-foreground mb-1 block text-[0.65rem]">
              {t("integration.admin.pinManagement.colConnections")}
            </Label>
            <label className="mb-1 flex items-center gap-2 text-xs" data-testid="pin-add-none">
              <Checkbox checked={newPinNone} onCheckedChange={(v) => setNewPinNone(v === true)} />
              {t("integration.admin.pinManagement.none")}
            </label>
            {!newPinNone && (
              <ConnectionSetChecklist
                connections={pinnableConnections}
                value={newConnectionIds}
                onChange={setNewConnectionIds}
                idPrefix="pin-add-connection"
              />
            )}
          </div>
          <Button
            size="sm"
            onClick={onSubmitNewPin}
            disabled={!canAddPin || upsertPin.isPending}
            data-testid="pin-add-submit"
          >
            {t("integration.admin.pinManagement.add")}
          </Button>
        </div>
      )}
    </div>
  );
}
