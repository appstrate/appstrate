// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Label } from "@appstrate/ui/components/label";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useIntegrationConnections } from "../hooks/use-integrations";
import type { ConnectionChoice } from "../lib/connection-choice";
import type { ConnectionSet } from "../lib/connection-set";
import { ClearChoiceButton } from "./integration-connect/clear-choice-button";
import { isSharedInSpace } from "./integration-connect/connection-ownership";
import { ConnectionSetChecklist } from "./integration-detail/connection-set-checklist";

/**
 * The connection section of a schedule running as someone other than the viewer, whose own
 * pickers would judge the VIEWER's connections. A refused save's candidates are the pick
 * control instead — only connections the viewer reaches too, so the list can be empty: the
 * actor's private connections are theirs (or an admin's) to pin. Why each was refused is said
 * once, by the form-level `ScheduleConnectionRefusals`. Stored picks nothing refused are shown
 * read-only, each integration's clearable. "No connection" (`[]`) is offered for each integration
 * the agent does not require.
 */
export function ScheduleActorConnectionChoice({
  choices,
  integrations,
  value,
  onChange,
}: {
  /** What the last save was refused over — kept on screen while it is answered. */
  choices: readonly ConnectionChoice[];
  /** The integrations the fired version declares. */
  integrations: readonly { id: string; required?: boolean }[];
  value: Readonly<Record<string, string[]>>;
  onChange: (integrationId: string, connectionIds: ConnectionSet) => void;
}) {
  const { t } = useTranslation(["agents"]);
  const optional = new Set(integrations.filter((i) => i.required !== true).map((i) => i.id));
  const refused = (integrationId: string) => choices.some((c) => c.integrationId === integrationId);
  const others = [...new Set([...Object.keys(value), ...optional])].filter((id) => !refused(id));
  return (
    <div className="space-y-2" data-testid="schedule-actor-connections">
      <Label>{t("schedule.connectionOverrides.label")}</Label>
      <p className="text-muted-foreground text-xs">
        {t("schedule.connectionOverrides.otherActor")}
      </p>
      {choices.map((choice) => (
        <div
          key={choice.integrationId}
          className="border-border bg-card space-y-1.5 rounded-md border p-3"
          data-testid={`schedule-actor-choice-${choice.integrationId}`}
        >
          <div
            id={`sched-choice-${choice.integrationId}-title`}
            className="font-mono text-xs font-medium"
          >
            {choice.integrationId}
          </div>
          <ConnectionSetChecklist
            // A dead connection fails the fire it is picked for; unticking stays open.
            options={choice.candidates.map((c) => ({
              id: c.id,
              disabled: c.needs_reconnection,
              label: <CandidateLabel candidate={c} />,
            }))}
            value={value[choice.integrationId] ?? null}
            onChange={(next) => onChange(choice.integrationId, next)}
            idPrefix={`sched-choice-${choice.integrationId}`}
            labelledBy={`sched-choice-${choice.integrationId}-title`}
            allowNone={optional.has(choice.integrationId)}
          />
          {/* No candidates travel with an unreachable pick: clearing it lets
              the next save resolve again, and ask again if it must. */}
          {choice.candidates.length === 0 && value[choice.integrationId] !== undefined && (
            <ClearChoiceButton onClick={() => onChange(choice.integrationId, null)} />
          )}
        </div>
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
          <div
            key={integrationId}
            className="border-border bg-card space-y-1.5 rounded-md border p-3"
            data-testid={`schedule-actor-none-${integrationId}`}
          >
            <div
              id={`sched-choice-${integrationId}-title`}
              className="font-mono text-xs font-medium"
            >
              {integrationId}
            </div>
            <ConnectionSetChecklist
              options={[]}
              value={value[integrationId] ?? null}
              onChange={(next) => onChange(integrationId, next)}
              idPrefix={`sched-choice-${integrationId}`}
              labelledBy={`sched-choice-${integrationId}-title`}
              allowNone
            />
          </div>
        ),
      )}
    </div>
  );
}

/** A refused save's candidate: own or shared by another member, and whether it is dead. */
function CandidateLabel({ candidate: c }: { candidate: ConnectionChoice["candidates"][number] }) {
  const { t } = useTranslation(["agents"]);
  return (
    <>
      {c.label}
      {/* "default" is the placeholder of a connection with no account identity. */}
      {c.account_id !== "default" && (
        <span className="text-muted-foreground"> · {c.account_id}</span>
      )}
      {!c.owned_by_actor && (
        <span className="text-muted-foreground">
          {" "}
          · {t("schedule.connectionOverrides.sharedByOther")}
        </span>
      )}
      {c.needs_reconnection && (
        <span className="text-muted-foreground">
          {" "}
          · {t("schedule.connectionOverrides.needsReconnection")}
        </span>
      )}
    </>
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
  const spaceId = useCurrentSpaceId();
  const labelOf = (id: string) =>
    visible?.find((c) => c.id === id && isSharedInSpace(c, spaceId))?.label ??
    t("schedule.connectionOverrides.privateConnection");
  return (
    <div
      className="border-border bg-card space-y-1.5 rounded-md border p-3"
      data-testid={`schedule-actor-stored-${integrationId}`}
    >
      <div className="font-mono text-xs font-medium">{integrationId}</div>
      <p className="text-xs">{connectionIds.map(labelOf).join(" · ")}</p>
      <ClearChoiceButton onClick={onClear} />
    </div>
  );
}
