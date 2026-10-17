// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { FormItem } from "@/components/app-ui/form-item";
import { OptionSelect } from "@/components/app-ui/option-select";
import type { IntegrationConnection, IntegrationPin } from "@appstrate/shared-types";
import { SettingsHeading } from "../settings/settings-heading";
import { ConfirmModal } from "../confirm-modal";
import { DataTable } from "../data-table";
import { FormModal } from "../form-modal";
import { usePinColumns } from "./pin-columns";
import { ConnectionCheckboxList } from "./connection-checkbox-list";
import {
  useIntegrationPins,
  useIntegrationConnections,
  useAgentsConsumingIntegration,
  useIntegrationOrgDefault,
  useUpsertIntegrationPin,
  useDeleteIntegrationPin,
} from "../../hooks/use-integrations";
import { unavailableConnectionIds } from "../../lib/connection-set";
import {
  ADDITIONS_REFUSAL_KEYS,
  PIN_MODE_HELP_KEYS,
  PIN_MODE_KEYS,
  PIN_MODES,
  PIN_SAVE_CONSEQUENCE_KEYS,
  initialPinDraft,
  pinDraftVerdict,
  type PinDraft,
  type PinMode,
} from "../../lib/admin-pin-payload";

/**
 * Per-agent pins: one per (agent, integration), holding the whole imposed SET and its mode (runs
 * use exactly that set, or that set plus the user's connections), both replaced on write. With an
 * org default in place, these are per-agent EXCEPTIONS. An empty set pins "no connection"; whether
 * that blocks a run is the running version's `required` to say. The table only reads: a pin is
 * added and edited in one form modal, and deleted only through its confirmation.
 */
export function PinManagementSection({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["settings", "common"]);
  const { data: pins, isLoading: pinsLoading, error: pinsError } = useIntegrationPins(packageId);
  const { data: connections, isLoading: connectionsLoading } = useIntegrationConnections(packageId);
  const { data: consumingAgents, isLoading: agentsLoading } =
    useAgentsConsumingIntegration(packageId);
  const deletePin = useDeleteIntegrationPin();
  // An enforced default accepts only « exact »: no pin of this integration may leave it meanwhile.
  const { data: orgDefault } = useIntegrationOrgDefault(packageId);
  const enforcedDefault = orgDefault?.enforce === true;

  // `pin: null` adds one. Both are mounted only while open: closing abandons the draft.
  const [form, setForm] = useState<{ pin: IntegrationPin | null } | null>(null);
  const [toDelete, setToDelete] = useState<IntegrationPin | null>(null);

  const pinnableConnections = (connections ?? []).filter((c) => c.shared_here);
  const agentDisplayName = (id: string) =>
    consumingAgents?.find((a) => a.agent_package_id === id)?.display_name ?? id;
  // Until the connections load, a stored member cannot be told unavailable: no edit yet.
  const onEdit = connections ? (pin: IntegrationPin) => setForm({ pin }) : undefined;

  const columns = usePinColumns({
    agentName: (pin) => agentDisplayName(pin.agent_package_id),
    pinnable: pinnableConnections,
    connections,
    isDeleting: (pin) => deletePin.isPending && toDelete?.agent_package_id === pin.agent_package_id,
    onEdit,
    onDelete: setToDelete,
  });

  const alreadyPinnedAgentIds = new Set((pins ?? []).map((p) => p.agent_package_id));
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
          rowAction={onEdit}
          isLoading={pinsLoading || agentsLoading}
          failure={pinsError}
          empty={
            <p className="text-muted-foreground px-3 py-3 text-xs italic">
              {t("integration.admin.pinManagement.empty")}
            </p>
          }
        />
      </div>

      {agentsLoading || connectionsLoading || pinsLoading ? (
        <Skeleton className="h-8 w-32" />
      ) : pinnableAgents.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">
          {t("integration.admin.pinManagement.noConsumingAgents")}
        </p>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setForm({ pin: null })}
          data-testid="pin-add"
        >
          {t("integration.admin.pinManagement.add")}
        </Button>
      )}

      {form && (
        <PinFormModal
          packageId={packageId}
          pin={form.pin}
          agents={
            form.pin
              ? [
                  {
                    agent_package_id: form.pin.agent_package_id,
                    display_name: agentDisplayName(form.pin.agent_package_id),
                  },
                ]
              : pinnableAgents
          }
          connections={pinnableConnections}
          enforcedDefault={enforcedDefault}
          onClose={() => setForm(null)}
        />
      )}

      {/* Mounted only for the pin the menu named: no stale target, and only its button deletes. */}
      {toDelete && (
        <PinDeleteConfirm
          pin={toDelete}
          agent={agentDisplayName(toDelete.agent_package_id)}
          isPending={deletePin.isPending}
          onClose={() => setToDelete(null)}
          onConfirm={() =>
            deletePin.mutate(
              { params: { path: { packageId, agentPackageId: toDelete.agent_package_id } } },
              { onSuccess: () => setToDelete(null) },
            )
          }
        />
      )}
    </div>
  );
}

/**
 * The one way to delete a pin. A closed pin takes every member choice with it; an open one, those
 * that only narrowed it (all of them under an enforced default); either may disable schedules.
 */
export function PinDeleteConfirm({
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
  const { t } = useTranslation(["settings", "common"]);
  return (
    <ConfirmModal
      open
      onClose={onClose}
      onConfirm={onConfirm}
      title={t("integration.admin.pinManagement.delete")}
      description={t("integration.admin.pinManagement.deleteConfirm", { agent })}
      confirmLabel={t("btn.delete", { ns: "common" })}
      isPending={isPending}
    >
      <p className="text-muted-foreground text-sm" data-testid="pin-delete-clears-choices">
        {t(
          pin.allow_additional_connections
            ? "integration.admin.pinManagement.deleteOpenClearsChoices"
            : "integration.admin.pinManagement.deleteClosedClearsChoices",
        )}
      </p>
    </ConfirmModal>
  );
}

interface PinFormProps {
  packageId: string;
  /** The pin edited, `null` for a new one. */
  pin: IntegrationPin | null;
  /** The agent of the pin edited, or the agents without a pin. */
  agents: { agent_package_id: string; display_name: string }[];
  /** The connections shared into the space. */
  connections: IntegrationConnection[];
  enforcedDefault: boolean;
  onClose: () => void;
}

/** Adds or edits one pin: its agent, its set, its mode; one PUT on submit. */
function PinFormModal({
  packageId,
  pin,
  agents,
  connections,
  enforcedDefault,
  onClose,
}: PinFormProps) {
  const { t } = useTranslation("settings");
  const upsertPin = useUpsertIntegrationPin();
  const [draft, setDraft] = useState(() => initialPinDraft(pin));
  const unavailableIds = pin
    ? unavailableConnectionIds(
        pin.connection_ids,
        connections.map((c) => c.id),
      )
    : [];
  const verdict = pinDraftVerdict({
    stored: pin,
    connectionIds: draft.connectionIds,
    chosenMode: draft.chosenMode,
    enforcedDefault,
    unavailableIds,
    // The agents offered for a new pin are the active ones.
    agentInactive: pin ? !pin.agent_active : false,
  });
  const canSubmit = draft.agent !== "" && verdict.savable;
  return (
    <FormModal
      title={
        pin
          ? t("integration.admin.pinManagement.editTitle", {
              agent: agents[0]?.display_name ?? pin.agent_package_id,
            })
          : t("integration.admin.pinManagement.addTitle")
      }
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        upsertPin.mutate(
          { params: { path: { packageId, agentPackageId: draft.agent } }, body: verdict.body },
          { onSuccess: onClose },
        );
      }}
      isPending={upsertPin.isPending}
      submitLabel={pin ? undefined : t("integration.admin.pinManagement.add")}
      submitDisabled={!canSubmit}
      submitTestId="pin-form-submit"
    >
      <PinFormFields
        editing={pin !== null}
        agents={agents}
        connections={connections}
        unavailableIds={unavailableIds}
        draft={draft}
        verdict={verdict}
        onChange={(patch) => setDraft((previous) => ({ ...previous, ...patch }))}
      />
    </FormModal>
  );
}

/** The fields, without the dialog chrome (a Radix dialog renders nothing without a DOM). */
export function PinFormFields({
  editing,
  agents,
  connections,
  unavailableIds,
  draft,
  verdict,
  onChange,
}: {
  editing: boolean;
  agents: PinFormProps["agents"];
  connections: IntegrationConnection[];
  /** Stored members no longer shared: listed, ticked until unticked. */
  unavailableIds: string[];
  draft: PinDraft;
  verdict: ReturnType<typeof pinDraftVerdict>;
  onChange: (patch: Partial<PinDraft>) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <>
      <FormItem id="pin-form-agent" label={t("integration.admin.pinManagement.colAgent")}>
        <OptionSelect
          value={draft.agent}
          onValueChange={(agent) => onChange({ agent })}
          // An edited pin keeps its agent: another agent is another pin.
          disabled={editing}
          placeholder={t("integration.admin.pinManagement.chooseAgent")}
          data-testid="pin-form-agent"
          options={agents.map((a) => ({ value: a.agent_package_id, label: a.display_name }))}
        />
      </FormItem>

      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">
          {t("integration.admin.pinManagement.colConnections")}
        </legend>
        {connections.length === 0 && unavailableIds.length === 0 && (
          <p className="text-muted-foreground text-xs italic">
            {t("integration.admin.pinManagement.noPinnableConnections")}
          </p>
        )}
        <ConnectionCheckboxList
          idPrefix="pin-form-connection"
          connections={connections}
          unavailableIds={unavailableIds}
          value={draft.connectionIds}
          onChange={(connectionIds) => onChange({ connectionIds })}
        />
        {draft.connectionIds.length === 0 && (
          <p className="text-muted-foreground text-xs" data-testid="pin-form-none">
            {t("integration.admin.pinManagement.noneChecked")}
          </p>
        )}
      </fieldset>

      <div className="flex flex-col gap-1">
        <FormItem
          id="pin-form-mode"
          label={t("integration.admin.pinManagement.colMode")}
          hint={t(PIN_MODE_HELP_KEYS[verdict.mode])}
        >
          <OptionSelect
            value={verdict.mode}
            onValueChange={(value) => onChange({ chosenMode: value as PinMode })}
            data-testid="pin-form-mode"
            options={PIN_MODES.map((value) => ({
              value,
              label: t(PIN_MODE_KEYS[value]),
              disabled: value === "plus" && verdict.refusal !== null,
            }))}
          />
        </FormItem>
        {verdict.refusal && (
          <p className="text-muted-foreground text-xs" data-testid="pin-form-mode-refusal">
            {t(ADDITIONS_REFUSAL_KEYS[verdict.refusal])}
          </p>
        )}
      </div>

      {verdict.consequence && (
        <p className="text-muted-foreground text-sm" data-testid="pin-form-consequence">
          {t(PIN_SAVE_CONSEQUENCE_KEYS[verdict.consequence])}
        </p>
      )}
    </>
  );
}
