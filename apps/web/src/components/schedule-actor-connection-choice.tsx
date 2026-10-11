// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@appstrate/ui/components/label";
import { useIntegrationConnections } from "../hooks/use-integrations";
import { useIntegrationName } from "../hooks/use-integration-name";
import type { ConnectionChoice } from "../lib/connection-choice";
import type { ConnectionSet } from "../lib/connection-set";
import { ClearChoiceButton } from "./integration-connect/clear-choice-button";
import { ConnectionSetPicker } from "./integration-connect/connection-choice-menu";
import type { SetOption } from "./integration-connect/connection-set-option";

/**
 * The connection section of a schedule running as someone other than the viewer, whose own
 * pickers would judge the VIEWER's connections. A refused save's candidates are the pick
 * control instead — only connections the viewer reaches too, so the list can be empty: the
 * actor's private connections are theirs (or an admin's) to pin. Why each was refused is said
 * once, by the form-level `ScheduleConnectionRefusals`. Stored picks nothing refused are shown
 * read-only, each integration's clearable. "No connection" (`[]`) is offered for each integration
 * the agent does not require.
 *
 * « Hériter » is offered only where nothing was refused: a refusal is the server saying the
 * actor's own resolution cannot decide, so inheriting is the very thing that is not an answer.
 */
export function ScheduleActorConnectionChoice({
  choices,
  integrations,
  value,
  onChange,
  showContext = true,
}: {
  /** What the last save was refused over — kept on screen while it is answered. */
  choices: readonly ConnectionChoice[];
  /** The integrations the fired version declares. */
  integrations: readonly { id: string; required?: boolean }[];
  value: Readonly<Record<string, string[]>>;
  onChange: (integrationId: string, connectionIds: ConnectionSet) => void;
  /** Says the connections are resolved for the actor; a form that just named it leaves it out. */
  showContext?: boolean;
}) {
  const { t } = useTranslation(["agents"]);
  const optional = new Set(integrations.filter((i) => i.required !== true).map((i) => i.id));
  const refused = (integrationId: string) => choices.some((c) => c.integrationId === integrationId);
  const others = [...new Set([...Object.keys(value), ...optional])].filter((id) => !refused(id));
  return (
    <div className="space-y-2" data-testid="schedule-actor-connections">
      <Label>{t("schedule.connectionOverrides.label")}</Label>
      {showContext && (
        <p className="text-muted-foreground text-xs">
          {t("schedule.connectionOverrides.otherActor")}
        </p>
      )}
      {choices.map((choice) => (
        <ChoiceCard
          key={choice.integrationId}
          integrationId={choice.integrationId}
          testId={`schedule-actor-choice-${choice.integrationId}`}
        >
          <ScheduleCandidatePicker
            choice={choice}
            value={value[choice.integrationId] ?? null}
            allowNone={optional.has(choice.integrationId)}
            onChange={(next) => onChange(choice.integrationId, next)}
          />
          {/* No candidates travel with an unreachable pick: clearing it lets
              the next save resolve again, and ask again if it must. */}
          {choice.candidates.length === 0 && value[choice.integrationId] !== undefined && (
            <ClearChoiceButton onClick={() => onChange(choice.integrationId, null)} />
          )}
        </ChoiceCard>
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
          <ChoiceCard
            key={integrationId}
            integrationId={integrationId}
            testId={`schedule-actor-none-${integrationId}`}
          >
            <ConnectionSetPicker
              options={[]}
              value={value[integrationId] ?? null}
              onChange={(next) => onChange(integrationId, next)}
              testPrefix="sched-choice-pick"
              testKey={integrationId}
              allowNone
              inheritDescription={t("schedule.connectionOverrides.inheritActor")}
            />
          </ChoiceCard>
        ),
      )}
    </div>
  );
}

/** One integration of the section: its display name, then what answers for it. */
function ChoiceCard({
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
    <div className="border-border bg-card space-y-1.5 rounded-md border p-3" data-testid={testId}>
      <div className="text-sm font-medium">{name}</div>
      {children}
    </div>
  );
}

/** A refused save's candidates as the choice: own or shared by another member, and whether it is dead. */
function ScheduleCandidatePicker({
  choice,
  value,
  allowNone,
  onChange,
}: {
  choice: ConnectionChoice;
  value: ConnectionSet;
  allowNone: boolean;
  onChange: (next: ConnectionSet) => void;
}) {
  const { t } = useTranslation(["agents"]);
  const options: SetOption[] = choice.candidates.map((c) => ({
    id: c.id,
    name: c.label,
    description: [
      // "default" is the placeholder of a connection with no account identity.
      c.account_id !== "default" ? c.account_id : null,
      !c.owned_by_actor ? t("schedule.connectionOverrides.sharedByOther") : null,
      c.needs_reconnection ? t("schedule.connectionOverrides.needsReconnection") : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" · "),
    // A dead connection fails the fire it is picked for; unticking stays open.
    disabled: c.needs_reconnection,
  }));
  return (
    <ConnectionSetPicker
      options={options}
      value={value}
      onChange={onChange}
      testPrefix="sched-choice-pick"
      testKey={choice.integrationId}
      allowNone={allowNone}
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
  const name = useIntegrationName(integrationId);
  const { data: visible } = useIntegrationConnections(integrationId);
  const labelOf = (id: string) =>
    visible?.find((c) => c.id === id && c.shared_here)?.label ??
    t("schedule.connectionOverrides.privateConnection");
  return (
    <div
      className="border-border bg-card space-y-1.5 rounded-md border p-3"
      data-testid={`schedule-actor-stored-${integrationId}`}
    >
      <div className="text-sm font-medium">{name}</div>
      <p className="text-xs">{connectionIds.map(labelOf).join(" · ")}</p>
      <ClearChoiceButton onClick={onClear} />
    </div>
  );
}
