// SPDX-License-Identifier: Apache-2.0

import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import type { components } from "../api/schema";
import type { ActorValue } from "../lib/schedule-payload";
import { describeResolution } from "./integration-connect/integration-run-readiness";
import { Card } from "@appstrate/ui/components/card";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@appstrate/ui/components/label";
import { CheckboxField } from "@/components/app-ui/checkbox-field";
import { useIntegrationConnections } from "../hooks/use-integrations";
import { useIntegrationName } from "../hooks/use-integration-name";
import { candidateDescription, type ConnectionChoice } from "../lib/connection-choice";
import { toggleCapped, type ConnectionSet } from "../lib/connection-set";
import { ClearChoiceButton } from "./integration-connect/clear-choice-button";

type Readiness = components["schemas"]["AgentConnectionReadiness"]["integrations"][number];
type CandidateGroup = {
  integrationId: string;
  candidates: Pick<
    ConnectionChoice["candidates"][number],
    "id" | "account_id" | "needs_reconnection" | "label" | "owned_by_actor"
  >[];
  max?: number;
  allowNone?: boolean;
};

/** Only a connection shared here is a portable choice for another member. Their own
 * pins and private connections are resolved by the server when this schedule fires. */
function sharedChoices(
  entries: readonly Readiness[],
  actor: ActorValue,
  picks: Readonly<Record<string, string[]>>,
): CandidateGroup[] {
  return entries.flatMap(
    ({
      integration_package_id: integrationId,
      resolution,
      inert,
      connection_required,
      required,
    }) => {
      const { lockedBy, lockedConnectionIds, additionsAllowed } = describeResolution(resolution);
      const inactive =
        resolution.error_code === "integration_not_active" ||
        resolution.warning?.code === "integration_not_active";
      const editable =
        connection_required && !inert && !inactive && (!lockedBy || additionsAllowed);
      const candidates = editable
        ? resolution.candidates
            .filter(
              (c) =>
                c.shared_here &&
                !lockedConnectionIds.includes(c.id) &&
                !c.needs_reconnection &&
                c.missing_scopes.length === 0,
            )
            .map((c) => ({
              id: c.id,
              account_id: c.account_id,
              needs_reconnection: c.needs_reconnection,
              label: c.owner_name ? `${c.label} — ${c.owner_name}` : c.label,
              owned_by_actor:
                c.owner_user_id === actor.userId || c.owner_end_user_id === actor.endUserId,
            }))
        : [];
      // An unchanged private/stale pick can be kept. Clear it explicitly before choosing a replacement.
      if (picks[integrationId]?.some((id) => !candidates.some((c) => c.id === id))) return [];
      return [
        {
          integrationId,
          candidates,
          max: MAX_CONNECTIONS_PER_INTEGRATION - lockedConnectionIds.length,
          allowNone: editable && !required && !lockedBy,
        },
      ];
    },
  );
}

/** Another actor's stored picks, the choices shared in the space, or a refused save's candidates. */
export function ScheduleActorConnectionChoice({
  choices,
  integrations,
  value,
  onChange,
  shared,
  showContext = true,
}: {
  /** What the last save was refused over — kept on screen while it is answered. */
  choices: readonly ConnectionChoice[];
  /** The integrations the fired version declares. */
  integrations: readonly { id: string; required?: boolean }[];
  value: Readonly<Record<string, string[]>>;
  onChange: (integrationId: string, connectionIds: ConnectionSet) => void;
  shared?: { entries: readonly Readiness[]; actor: ActorValue };
  /** Says the connections are resolved for the actor; a form that just named it leaves it out. */
  showContext?: boolean;
}) {
  const { t } = useTranslation(["agents"]);
  const optional = new Set(integrations.filter((i) => i.required !== true).map((i) => i.id));
  const groups: readonly CandidateGroup[] = shared
    ? sharedChoices(shared.entries, shared.actor, value)
    : choices;
  const hasGroup = (integrationId: string) => groups.some((c) => c.integrationId === integrationId);
  const others = [...new Set([...Object.keys(value), ...optional])].filter((id) => !hasGroup(id));
  return (
    <div className="flex flex-col gap-2" data-testid="schedule-actor-connections">
      <Label className="mb-0">{t("connectionOverrides.label")}</Label>
      {showContext && (
        <p className="text-muted-foreground text-xs">
          {t("schedule.connectionOverrides.otherActor")}
        </p>
      )}
      {groups.map((choice) => (
        <IntegrationChoiceBox
          key={choice.integrationId}
          integrationId={choice.integrationId}
          testId={`schedule-actor-choice-${choice.integrationId}`}
        >
          <ScheduleCandidatePicker
            choice={choice}
            value={value[choice.integrationId] ?? null}
            allowNone={choice.allowNone ?? optional.has(choice.integrationId)}
            onChange={(next) => onChange(choice.integrationId, next)}
          />
          {shared && value[choice.integrationId] === undefined && (
            <p className="text-muted-foreground text-xs">
              {t("schedule.connectionOverrides.inheritActor")}
            </p>
          )}
          {/* No candidates travel with an unreachable pick: clearing it lets
              the next save resolve again, and ask again if it must. */}
          {choice.candidates.length === 0 && value[choice.integrationId] !== undefined && (
            <div>
              <ClearChoiceButton onClick={() => onChange(choice.integrationId, null)} />
            </div>
          )}
        </IntegrationChoiceBox>
      ))}
      {others.map((integrationId) =>
        (value[integrationId]?.length ?? 0) > 0 ? (
          <StoredChoice
            key={integrationId}
            integrationId={integrationId}
            connectionIds={value[integrationId]!}
            onClear={() => onChange(integrationId, null)}
          />
        ) : (
          <IntegrationChoiceBox
            key={integrationId}
            integrationId={integrationId}
            testId={`schedule-actor-none-${integrationId}`}
          >
            <NoneBox
              integrationId={integrationId}
              value={value[integrationId] ?? null}
              onChange={(next) => onChange(integrationId, next)}
            />
            {value[integrationId] === undefined && (
              <p className="text-muted-foreground text-xs">
                {t("schedule.connectionOverrides.inheritActor")}
              </p>
            )}
          </IntegrationChoiceBox>
        ),
      )}
    </div>
  );
}

/** One integration of the section: its display name, then what answers for it. */
function IntegrationChoiceBox({
  integrationId,
  testId,
  children,
}: {
  integrationId: string;
  testId: string;
  children: ReactNode;
}) {
  const name = useIntegrationName(integrationId);
  return (
    <Card className="flex flex-col gap-1.5 rounded-md p-3" data-testid={testId}>
      <div className="text-sm font-medium">{name}</div>
      {children}
    </Card>
  );
}

/** A refused save's candidates as boxes: own or shared by another member, and whether it is dead. */
function ScheduleCandidatePicker({
  choice,
  value,
  allowNone,
  onChange,
}: {
  choice: CandidateGroup;
  value: ConnectionSet;
  allowNone: boolean;
  onChange: (next: ConnectionSet) => void;
}) {
  const { t } = useTranslation(["agents"]);
  const picked = value ?? [];
  const labels = {
    sharedByOther: t("schedule.connectionOverrides.sharedByOther"),
    needsReconnection: t("schedule.connectionOverrides.needsReconnection"),
  };
  return (
    <div role="group" className="flex flex-col gap-3">
      {choice.candidates.map((c) => {
        const checked = picked.includes(c.id);
        return (
          <CheckboxField
            key={c.id}
            id={`sched-choice-pick-option-${c.id}`}
            data-testid={`sched-choice-pick-option-${c.id}`}
            label={c.label}
            description={candidateDescription(c, labels)}
            checked={checked}
            // A dead connection fails the fire it is picked for; unticking stays open.
            disabled={
              !checked &&
              (c.needs_reconnection ||
                picked.length >= (choice.max ?? MAX_CONNECTIONS_PER_INTEGRATION))
            }
            onCheckedChange={() => {
              // Unticking the last box is no choice at this layer, never « no connection ».
              const next = toggleCapped(picked, c.id, choice.max);
              onChange(next.length > 0 ? next : null);
            }}
          />
        );
      })}
      {allowNone && (
        <NoneBox integrationId={choice.integrationId} value={value} onChange={onChange} />
      )}
    </div>
  );
}

/** « Aucune connexion » (`[]`), for an integration the agent does not require; unticked, no choice. */
function NoneBox({
  integrationId,
  value,
  onChange,
}: {
  integrationId: string;
  value: ConnectionSet;
  onChange: (next: ConnectionSet) => void;
}) {
  const { t } = useTranslation(["agents"]);
  return (
    <CheckboxField
      id={`sched-choice-pick-none-${integrationId}`}
      data-testid={`sched-choice-pick-none-${integrationId}`}
      label={t("detail.integrationMemberPicker.none")}
      description={t("detail.integrationMemberPicker.noneHint")}
      checked={value?.length === 0}
      onCheckedChange={(checked) => onChange(checked === true ? [] : null)}
    />
  );
}

/** A stored pick: named when the viewer sees it shared, else only said to be private. */
function StoredChoice({
  integrationId,
  connectionIds,
  onClear,
}: {
  integrationId: string;
  connectionIds: string[];
  onClear: () => void;
}) {
  const { t } = useTranslation(["agents"]);
  const { data: visible } = useIntegrationConnections(integrationId);
  const labelOf = (id: string) =>
    visible?.find((c) => c.id === id && c.shared_here)?.label ??
    t("schedule.connectionOverrides.privateConnection");
  return (
    <IntegrationChoiceBox
      integrationId={integrationId}
      testId={`schedule-actor-stored-${integrationId}`}
    >
      <p className="text-xs">{connectionIds.map(labelOf).join(" · ")}</p>
      <div>
        <ClearChoiceButton onClick={onClear} />
      </div>
    </IntegrationChoiceBox>
  );
}
