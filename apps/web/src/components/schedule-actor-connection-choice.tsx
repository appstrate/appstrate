// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Label } from "@appstrate/ui/components/label";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import { useIntegrationConnections } from "../hooks/use-integrations";
import type { ConnectionChoice } from "../lib/connection-choice";
import { toggleCapped, type ConnectionSet } from "../lib/connection-set";
import { ClearChoiceButton } from "./integration-connect/clear-choice-button";

/**
 * The connection section of a schedule running as someone other than the viewer, whose own
 * pickers would judge the VIEWER's connections. A refused save's candidates are the pick
 * control instead — only connections the viewer reaches too, so the list can be empty: the
 * actor's private connections are theirs (or an admin's) to pin. Why each was refused is said
 * once, by the form-level `ScheduleConnectionRefusals`. Stored picks nothing refused are shown
 * read-only, each integration's clearable. Unticking the last connection clears the pick: "no
 * connection" is chosen from the viewer's own pickers, never left behind by an untick.
 */
export function ScheduleActorConnectionChoice({
  choices,
  value,
  onChange,
}: {
  /** What the last save was refused over — kept on screen while it is answered. */
  choices: readonly ConnectionChoice[];
  value: Readonly<Record<string, string[]>>;
  onChange: (integrationId: string, connectionIds: ConnectionSet) => void;
}) {
  const { t } = useTranslation(["agents"]);
  const storedOnly = Object.keys(value).filter(
    (integrationId) => !choices.some((c) => c.integrationId === integrationId),
  );
  return (
    <div className="space-y-2" data-testid="schedule-actor-connections">
      <Label>{t("schedule.connectionOverrides.label")}</Label>
      <p className="text-muted-foreground text-xs">
        {t("schedule.connectionOverrides.otherActor")}
      </p>
      {choices.map((choice) => {
        const picked = value[choice.integrationId] ?? [];
        const atCap = picked.length >= MAX_CONNECTIONS_PER_INTEGRATION;
        return (
          <div
            key={choice.integrationId}
            className="border-border bg-card space-y-1.5 rounded-md border p-3"
            data-testid={`schedule-actor-choice-${choice.integrationId}`}
          >
            <div className="font-mono text-xs font-medium">{choice.integrationId}</div>
            {choice.candidates.map((c) => {
              const id = `sched-choice-${choice.integrationId}-${c.id}`;
              const isPicked = picked.includes(c.id);
              return (
                <div key={c.id} className="flex items-center gap-2 text-xs">
                  <Checkbox
                    id={id}
                    checked={isPicked}
                    // A dead connection fails the fire it is picked for; unticking stays open.
                    disabled={(c.needs_reconnection || atCap) && !isPicked}
                    onCheckedChange={() => {
                      const next = toggleCapped(picked, c.id);
                      onChange(choice.integrationId, next.length > 0 ? next : null);
                    }}
                  />
                  <Label htmlFor={id} className="font-normal">
                    {c.label}
                    <span className="text-muted-foreground"> · {c.account_id}</span>
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
                  </Label>
                </div>
              );
            })}
            {atCap && choice.candidates.length > 0 && (
              <p className="text-muted-foreground text-xs">
                {t("detail.integrationMemberPicker.maxReached", {
                  max: MAX_CONNECTIONS_PER_INTEGRATION,
                })}
              </p>
            )}
            {/* No candidates travel with an unreachable pick: clearing it lets
                the next save resolve again, and ask again if it must. */}
            {choice.candidates.length === 0 && picked.length > 0 && (
              <ClearChoiceButton onClick={() => onChange(choice.integrationId, null)} />
            )}
          </div>
        );
      })}
      {storedOnly.map((integrationId) => (
        <StoredChoice
          key={integrationId}
          integrationId={integrationId}
          connectionIds={value[integrationId] ?? []}
          onClear={() => onChange(integrationId, null)}
        />
      ))}
    </div>
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
    visible?.find((c) => c.id === id && c.shared_with_org)?.label ??
    t("schedule.connectionOverrides.privateConnection");
  return (
    <div
      className="border-border bg-card space-y-1.5 rounded-md border p-3"
      data-testid={`schedule-actor-stored-${integrationId}`}
    >
      <div className="font-mono text-xs font-medium">{integrationId}</div>
      <p className="text-xs">
        {connectionIds.length > 0
          ? connectionIds.map(labelOf).join(" · ")
          : t("detail.integrationMemberPicker.none")}
      </p>
      <ClearChoiceButton onClick={onClear} />
    </div>
  );
}
