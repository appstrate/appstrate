// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Label } from "@appstrate/ui/components/label";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import type { ConnectionChoice } from "../lib/connection-choice";
import { toggleCapped } from "../lib/connection-set";

/**
 * The connection section of a schedule that runs as someone other than the
 * viewer. The viewer's own pickers would judge the VIEWER's connections, so they
 * are not shown: the server resolves for the schedule's actor, and when a save is
 * refused for a choice, that refusal's own candidates (the actor's side) are the
 * pick control, writing into the same `connection_overrides`.
 */
export function ScheduleActorConnectionChoice({
  choices,
  pendingIds,
  value,
  onChange,
}: {
  /** What the last save was refused over — kept on screen while it is answered. */
  choices: readonly ConnectionChoice[];
  /** Among them, the integrations whose pick has not moved since the refusal. */
  pendingIds: readonly string[];
  value: Readonly<Record<string, string[]>>;
  onChange: (integrationId: string, connectionIds: string[]) => void;
}) {
  const { t } = useTranslation(["agents"]);
  return (
    <div className="space-y-2" data-testid="schedule-actor-connections">
      <Label>{t("schedule.connectionOverrides.label")}</Label>
      <p className="text-muted-foreground text-xs">
        {t("schedule.connectionOverrides.otherActor")}
      </p>
      {choices.map((choice) => {
        const picked = value[choice.integrationId] ?? [];
        return (
          <div
            key={choice.integrationId}
            className="border-border bg-card space-y-1.5 rounded-md border p-3"
            data-testid={`schedule-actor-choice-${choice.integrationId}`}
          >
            <div className="font-mono text-xs font-medium">{choice.integrationId}</div>
            {pendingIds.includes(choice.integrationId) && (
              <p className="text-destructive text-xs" role="alert">
                {choice.code === "override_connection_unavailable"
                  ? t("schedule.connectionOverrides.unavailable")
                  : t("schedule.connectionOverrides.mustChoose")}
              </p>
            )}
            {choice.candidates.map((c) => {
              const id = `sched-choice-${choice.integrationId}-${c.id}`;
              return (
                <div key={c.id} className="flex items-center gap-2 text-xs">
                  <Checkbox
                    id={id}
                    checked={picked.includes(c.id)}
                    // A dead connection fails the fire it is picked for.
                    disabled={c.needs_reconnection}
                    onCheckedChange={() =>
                      onChange(
                        choice.integrationId,
                        toggleCapped(picked, c.id, MAX_CONNECTIONS_PER_INTEGRATION),
                      )
                    }
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
            {/* No candidates travel with an unreachable pick: clearing it lets
                the next save resolve again, and ask again if it must. */}
            {choice.candidates.length === 0 && picked.length > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onChange(choice.integrationId, [])}
              >
                {t("schedule.connectionOverrides.clearChoice")}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
