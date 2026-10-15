// SPDX-License-Identifier: Apache-2.0

/**
 * What a delete rewrites among the caller's own member pins and schedule overrides, and how many
 * schedules it disables, said before the user confirms. The confirmation owns the
 * query and keeps its button disabled while it is in flight.
 */

import { Alert } from "@appstrate/ui/components/alert";
import { Trans, useTranslation } from "react-i18next";
import { AlertDescription, AlertTitle } from "@appstrate/ui/components/alert";
import type { useConnectionDeleteImpact } from "../../hooks/use-me-connections";
import { errorDetail } from "../../lib/mutation-error";
import { TextSkeleton } from "../loading-skeletons";

export function ConnectionDeleteImpact({
  impact,
}: {
  impact: { data: ReturnType<typeof useConnectionDeleteImpact>["data"]; error: unknown };
}) {
  const { t } = useTranslation("settings");
  const { data, error } = impact;

  if (error) {
    const detail = errorDetail(error);
    return (
      <div className="text-destructive mt-4 text-sm" data-testid="connection-delete-impact-error">
        <p>{t("connections.deleteImpact.error")}</p>
        {detail && <p className="mt-1">{detail}</p>}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="mt-4" data-testid="connection-delete-impact-loading">
        <TextSkeleton lines={2} />
      </div>
    );
  }
  const othersDisabled = data.other_schedules_disabled_count;
  if (data.pins.length === 0 && data.schedules.length === 0 && othersDisabled === 0) return null;

  return (
    <Alert variant="warning" className="mt-4" data-testid="connection-delete-impact">
      <AlertTitle>{t("connections.impact.title")}</AlertTitle>
      <AlertDescription>
        {(data.pins.length > 0 || data.schedules.length > 0) && (
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {data.pins.map((pin) => {
              const effect =
                pin.connection_count > 1
                  ? t("connections.impact.shrinks", {
                      count: pin.connection_count - 1,
                      from: pin.connection_count,
                    })
                  : t("connections.impact.agentResets");
              return (
                <li key={`${pin.agent_package_id}|${pin.integration_package_id}`}>
                  <Trans
                    t={t}
                    i18nKey="connections.impact.agentLine"
                    values={{
                      effect:
                        pin.schedules_disabled_count > 0
                          ? t("connections.impact.effectThenSchedules", {
                              effect,
                              schedules: t("connections.impact.disablesSchedules", {
                                count: pin.schedules_disabled_count,
                              }),
                            })
                          : effect,
                    }}
                    components={{
                      name: <span className="font-medium">{pin.agent_display_name}</span>,
                    }}
                  />
                </li>
              );
            })}
            {data.schedules.map((schedule) => (
              <li key={`${schedule.scheduleId}|${schedule.integration_package_id}`}>
                <Trans
                  t={t}
                  i18nKey="connections.impact.scheduleLine"
                  values={{
                    agent: schedule.agent_display_name,
                    effect: schedule.disables
                      ? t("connections.impact.scheduleDisables")
                      : schedule.connection_count > 1
                        ? t("connections.impact.shrinks", {
                            count: schedule.connection_count - 1,
                            from: schedule.connection_count,
                          })
                        : t("connections.impact.scheduleResets"),
                  }}
                  components={{
                    name: (
                      <span className="font-medium">
                        {schedule.schedule_name ?? t("connections.scheduleImpact.unnamed")}
                      </span>
                    ),
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        {othersDisabled > 0 && (
          <p className="mt-1">
            {t("connections.scheduleImpact.othersDisabled", { count: othersDisabled })}
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}
