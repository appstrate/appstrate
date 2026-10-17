// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Label } from "@appstrate/ui/components/label";
import { Switch } from "@appstrate/ui/components/switch";
import { OptionSelect } from "@/components/app-ui/option-select";
import { SettingsHeading } from "../settings/settings-heading";
import { SettingRow } from "../settings/setting-row";
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
  useIntegrationOrgDefault,
  useUpsertIntegrationPin,
  useDeleteIntegrationPin,
} from "../../hooks/use-integrations";
import type { ConnectionSet } from "../../lib/connection-set";
import {
  additionsRefusal,
  ADDITIONS_REFUSAL_KEYS,
  adminPinBody,
  toggledAdditionsBody,
} from "../../lib/admin-pin-payload";
import { ConnectionSetPicker } from "../integration-connect/connection-choice-menu";
import { connectionSetOption } from "../integration-connect/connection-set-option";

/**
 * Per-agent pins: one per (agent, integration), holding the whole imposed SET and whether runs
 * may add to it, both replaced on write. With an org default in place, these are per-agent
 * EXCEPTIONS. An empty set pins "no connection"; whether that blocks a run is the running
 * version's `required` to say.
 */
export function PinManagementSection({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["settings", "agents"]);
  const { data: pins, isLoading: pinsLoading, error: pinsError } = useIntegrationPins(packageId);
  const { data: connections, isLoading: connectionsLoading } = useIntegrationConnections(packageId);
  const { data: consumingAgents, isLoading: agentsLoading } =
    useAgentsConsumingIntegration(packageId);
  const deletePin = useDeleteIntegrationPin();
  const togglePin = useUpsertIntegrationPin();
  // An enforced default is always closed: no pin of this integration may open while it holds.
  const { data: orgDefault } = useIntegrationOrgDefault(packageId);
  const enforcedDefault = orgDefault?.enforce === true;

  const [adding, setAdding] = useState(false);
  const [toDelete, setToDelete] = useState<IntegrationPin | null>(null);
  // Every flip of the switch clears the members' own choices for the agent, so it is confirmed.
  const [toToggle, setToToggle] = useState<IntegrationPin | null>(null);

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
    enforcedDefault,
    isToggling: (pin) =>
      togglePin.isPending &&
      togglePin.variables?.params.path.agentPackageId === pin.agent_package_id,
    onToggleAdditions: setToToggle,
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
          tiered
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
          enforcedDefault={enforcedDefault}
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
      >
        {/* A closed pin takes every member choice with it; an open one, those that only narrowed it; either may disable schedules. */}
        {toDelete && (
          <p className="text-muted-foreground text-sm" data-testid="pin-delete-clears-choices">
            {t(
              toDelete.allow_additional_connections
                ? "integration.admin.pinManagement.deleteOpenClearsChoices"
                : "integration.admin.pinManagement.deleteClosedClearsChoices",
            )}
          </p>
        )}
      </ConfirmModal>

      {toToggle && (
        <AdditionsToggleConfirm
          pin={toToggle}
          agent={agentDisplayName(toToggle.agent_package_id)}
          isPending={togglePin.isPending}
          onClose={() => setToToggle(null)}
          onConfirm={() =>
            togglePin.mutate(
              {
                params: { path: { packageId, agentPackageId: toToggle.agent_package_id } },
                body: toggledAdditionsBody(toToggle),
              },
              { onSuccess: () => setToToggle(null) },
            )
          }
        />
      )}
    </div>
  );
}

/**
 * Flipping a pin's additions switch: the server deletes the members' own choices for the agent
 * whenever the pin is closed before or after (a member pin never survives under a closed pin),
 * so either way the body says so; opening repeats what a run may then combine, closing that the
 * schedules whose overrides add connections fail at their next run and stay disabled.
 */
export function AdditionsToggleConfirm({
  pin,
  agent,
  isPending,
  onClose,
  onConfirm,
}: {
  pin: IntegrationPin;
  agent: string;
  isPending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("settings");
  const opening = !pin.allow_additional_connections;
  return (
    <ConfirmModal
      open
      onClose={onClose}
      onConfirm={onConfirm}
      title={t(
        opening
          ? "integration.admin.pinManagement.openAdditionsTitle"
          : "integration.admin.pinManagement.closeAdditionsTitle",
        { agent },
      )}
      description={t("integration.admin.pinManagement.clearsMemberChoices")}
      confirmLabel={t(
        opening
          ? "integration.admin.pinManagement.openAdditions"
          : "integration.admin.pinManagement.closeAdditions",
      )}
      variant="default"
      isPending={isPending}
    >
      <p className="text-muted-foreground text-sm">
        {t(
          opening
            ? "integration.admin.pinManagement.allowAdditionsHelp"
            : "integration.admin.pinManagement.closeAdditionsSchedules",
        )}
      </p>
    </ConfirmModal>
  );
}

/**
 * Pins one agent to a set of connections, or to none, closed to additions unless the admin opens
 * it (never over none, nor while the space enforces a default); `onDone` closes it.
 */
export function NewPinForm({
  packageId,
  agents,
  connections,
  enforcedDefault,
  onDone,
}: {
  packageId: string;
  agents: { agent_package_id: string; display_name: string }[];
  connections: IntegrationConnection[];
  enforcedDefault: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const upsertPin = useUpsertIntegrationPin();
  const [newAgent, setNewAgent] = useState("");
  const [newConnectionIds, setNewConnectionIds] = useState<ConnectionSet>(null);
  const [allowAdditions, setAllowAdditions] = useState(false);
  // Only shared connections are offered here: none can be unavailable.
  const refusal = additionsRefusal(
    { connection_ids: newConnectionIds, allow_additional_connections: false },
    // The agents offered are the active ones.
    { enforcedDefault, unavailableIds: [], agentInactive: false },
  );
  // A switch that cannot be on reads off, whatever was flipped before the set emptied.
  const opened = allowAdditions && refusal === null;

  const onSubmitNewPin = () => {
    if (!newAgent || newConnectionIds === null) return;
    upsertPin.mutate(
      {
        params: { path: { packageId, agentPackageId: newAgent } },
        body: adminPinBody({
          connection_ids: newConnectionIds,
          allow_additional_connections: opened,
        }),
      },
      { onSuccess: onDone },
    );
  };

  return (
    <div className="flex flex-col gap-3" data-testid="pin-add-form">
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
      </div>
      <SettingRow
        variant="toggle"
        label={
          <Label htmlFor="pin-add-additions" className="cursor-pointer">
            {t("integration.admin.pinManagement.allowAdditions")}
          </Label>
        }
        description={
          <>
            {t("integration.admin.pinManagement.allowAdditionsHelp")}
            {refusal && (
              <span className="mt-1 block" data-testid="pin-add-additions-refusal">
                {t(ADDITIONS_REFUSAL_KEYS[refusal])}
              </span>
            )}
            {/* A closed pin clears the members' own choices for the agent; an open one keeps them. */}
            {!opened && (
              <span className="mt-1 block" data-testid="pin-add-clears-choices">
                {t("integration.admin.pinManagement.clearsMemberChoices")}
              </span>
            )}
          </>
        }
      >
        <Switch
          id="pin-add-additions"
          checked={opened}
          disabled={refusal !== null || upsertPin.isPending}
          onCheckedChange={(checked) => setAllowAdditions(checked === true)}
          data-testid="pin-add-additions"
        />
      </SettingRow>
      <div className="flex gap-2">
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
    </div>
  );
}
