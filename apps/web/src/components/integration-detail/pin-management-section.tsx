// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Label } from "@appstrate/ui/components/label";
import { OptionSelect } from "@/components/app-ui/option-select";
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
  useIntegrationOrgDefault,
  useUpsertIntegrationPin,
  useDeleteIntegrationPin,
} from "../../hooks/use-integrations";
import type { ConnectionSet } from "../../lib/connection-set";
import {
  additionsRefusal,
  ADDITIONS_REFUSAL_KEYS,
  adminPinBody,
  PIN_MODE_HELP_KEYS,
  PIN_MODE_KEYS,
  PIN_MODES,
  pinMode,
  switchedModeBody,
  type PinMode,
} from "../../lib/admin-pin-payload";
import { ConnectionSetPicker } from "../integration-connect/connection-choice-menu";
import { connectionSetOption } from "../integration-connect/connection-set-option";

/**
 * Per-agent pins: one per (agent, integration), holding the whole imposed SET and its mode (runs
 * use exactly that set, or that set plus the user's connections), both replaced on write. With an
 * org default in place, these are per-agent EXCEPTIONS. An empty set pins "no connection"; whether
 * that blocks a run is the running version's `required` to say.
 */
export function PinManagementSection({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["settings", "agents"]);
  const { data: pins, isLoading: pinsLoading, error: pinsError } = useIntegrationPins(packageId);
  const { data: connections, isLoading: connectionsLoading } = useIntegrationConnections(packageId);
  const { data: consumingAgents, isLoading: agentsLoading } =
    useAgentsConsumingIntegration(packageId);
  const deletePin = useDeleteIntegrationPin();
  const changeMode = useUpsertIntegrationPin();
  // An enforced default accepts only « exact »: no pin of this integration may leave it meanwhile.
  const { data: orgDefault } = useIntegrationOrgDefault(packageId);
  const enforcedDefault = orgDefault?.enforce === true;

  const [adding, setAdding] = useState(false);
  const [toDelete, setToDelete] = useState<IntegrationPin | null>(null);
  // Every change of mode clears the members' own choices for the agent, so it is confirmed.
  const [toChange, setToChange] = useState<IntegrationPin | null>(null);

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
    isChangingMode: (pin) =>
      changeMode.isPending &&
      changeMode.variables?.params.path.agentPackageId === pin.agent_package_id,
    onChangeMode: setToChange,
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

      {toChange && (
        <PinModeConfirm
          pin={toChange}
          agent={agentDisplayName(toChange.agent_package_id)}
          isPending={changeMode.isPending}
          onClose={() => setToChange(null)}
          onConfirm={() =>
            changeMode.mutate(
              {
                params: { path: { packageId, agentPackageId: toChange.agent_package_id } },
                body: switchedModeBody(toChange),
              },
              { onSuccess: () => setToChange(null) },
            )
          }
        />
      )}
    </div>
  );
}

/**
 * Changing a pin's mode: the server deletes the members' own choices for the agent whenever the pin
 * is « exact » before or after (a member pin never survives under it), so either way the body says
 * so; moving to « plus » repeats what a run may then combine, moving to « exact » that the schedules
 * whose overrides add connections fail at their next run and stay disabled.
 */
export function PinModeConfirm({
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
  const toPlus = pinMode(pin) === "exact";
  return (
    <ConfirmModal
      open
      onClose={onClose}
      onConfirm={onConfirm}
      title={t(
        toPlus
          ? "integration.admin.pinManagement.toPlusTitle"
          : "integration.admin.pinManagement.toExactTitle",
        { agent },
      )}
      description={t("integration.admin.pinManagement.clearsMemberChoices")}
      confirmLabel={t("integration.admin.pinManagement.changeMode")}
      variant="default"
      isPending={isPending}
    >
      <p className="text-muted-foreground text-sm">
        {t(
          toPlus
            ? "integration.admin.pinManagement.modePlusHelp"
            : "integration.admin.pinManagement.toExactSchedules",
        )}
      </p>
    </ConfirmModal>
  );
}

/**
 * Pins one agent to a set of connections, or to none, in « exact » mode unless the admin picks
 * « plus » (never over none, nor while the space enforces a default); `onDone` closes it.
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
  const [chosenMode, setChosenMode] = useState<PinMode>("exact");
  // Only shared connections are offered here: none can be unavailable.
  const refusal = additionsRefusal(
    { connection_ids: newConnectionIds, allow_additional_connections: false },
    // The agents offered are the active ones.
    { enforcedDefault, unavailableIds: [], agentInactive: false },
  );
  // « plus » unavailable reads « exact », whatever was chosen before the set emptied.
  const mode: PinMode = refusal === null ? chosenMode : "exact";

  const onSubmitNewPin = () => {
    if (!newAgent || newConnectionIds === null) return;
    upsertPin.mutate(
      {
        params: { path: { packageId, agentPackageId: newAgent } },
        body: adminPinBody({
          connection_ids: newConnectionIds,
          allow_additional_connections: mode === "plus",
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
      <div className="max-w-md">
        <Label htmlFor="pin-add-mode" className="mb-2 block text-sm">
          {t("integration.admin.pinManagement.colMode")}
        </Label>
        <OptionSelect
          id="pin-add-mode"
          value={mode}
          onValueChange={(value) => setChosenMode(value as PinMode)}
          disabled={upsertPin.isPending}
          data-testid="pin-add-mode"
          options={PIN_MODES.map((value) => ({
            value,
            label: t(PIN_MODE_KEYS[value]),
            disabled: value === "plus" && refusal !== null,
          }))}
        />
        <p className="text-muted-foreground mt-2 text-sm">{t(PIN_MODE_HELP_KEYS[mode])}</p>
        {refusal && (
          <p className="text-muted-foreground mt-1 text-xs" data-testid="pin-add-mode-refusal">
            {t(ADDITIONS_REFUSAL_KEYS[refusal])}
          </p>
        )}
        {/* « exact » clears the members' own choices for the agent; « plus » keeps them. */}
        {mode === "exact" && (
          <p className="text-muted-foreground mt-1 text-sm" data-testid="pin-add-clears-choices">
            {t("integration.admin.pinManagement.clearsMemberChoices")}
          </p>
        )}
      </div>
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
