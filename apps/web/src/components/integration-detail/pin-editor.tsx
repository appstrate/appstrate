// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FormItem } from "@/components/app-ui/form-item";
import { OptionSelect } from "@/components/app-ui/option-select";
import type {
  ConsumingAgentSummary,
  IntegrationConnection,
  IntegrationPin,
} from "@appstrate/shared-types";
import { ConfirmModal } from "../confirm-modal";
import { FormModal } from "../form-modal";
import { ConnectionCheckboxList } from "./connection-checkbox-list";
import { useUpsertIntegrationPin } from "../../hooks/use-integrations";
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

export interface PinForm {
  /** The pin edited, `null` for a new one. */
  pin: IntegrationPin | null;
  /** The agent of the pin edited, the one a new pin is for, or the agents without a pin. */
  agents: ConsumingAgentSummary[];
  /** A new pin's agent, fixed by the screen that opened the form (the agent's own page). */
  agentId?: string;
}

/**
 * The one way to delete a pin. A closed pin has no member choice to lose (the server purged them
 * when it was closed): only the schedules whose override narrowed its set are disabled. An open
 * one also takes the member choices that only narrowed it (all of them under an enforced default),
 * and may disable schedules.
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
      confirmLabel={t("btn.remove", { ns: "common" })}
      isPending={isPending}
    >
      <p className="text-muted-foreground text-sm" data-testid="pin-delete-consequence">
        {t(
          pin.allow_additional_connections
            ? "integration.admin.pinManagement.deleteOpenClearsChoices"
            : "integration.admin.pinManagement.deleteClosedDisablesSchedules",
        )}
      </p>
    </ConfirmModal>
  );
}

interface PinFormProps extends PinForm {
  packageId: string;
  /** The connections shared into the space. */
  connections: IntegrationConnection[];
  enforcedDefault: boolean;
  onClose: () => void;
}

/** Adds or edits one pin: its agent, its set, its mode; one PUT on submit. */
export function PinFormModal({
  packageId,
  pin,
  agents,
  agentId,
  connections,
  enforcedDefault,
  onClose,
}: PinFormProps) {
  const { t } = useTranslation("settings");
  const upsertPin = useUpsertIntegrationPin();
  const [draft, setDraft] = useState(() => ({
    ...initialPinDraft(pin),
    ...(agentId !== undefined && { agent: agentId }),
  }));
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
        agentFixed={pin !== null || agentId !== undefined}
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
  agentFixed,
  agents,
  connections,
  unavailableIds,
  draft,
  verdict,
  onChange,
}: {
  /** An edited pin keeps its agent (another agent is another pin), and the agent's page pins that agent. */
  agentFixed: boolean;
  agents: PinForm["agents"];
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
          disabled={agentFixed}
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
