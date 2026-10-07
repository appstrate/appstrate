// SPDX-License-Identifier: Apache-2.0

/**
 * What a delete rewrites among the caller's own member pins and schedule overrides, said
 * before the user confirms. The confirmation owns the query and keeps its button disabled
 * while it is in flight.
 */

import { useTranslation } from "react-i18next";
import type { useConnectionDeleteImpact } from "../../hooks/use-me-connections";
import { errorDetail } from "../../lib/mutation-error";
import { Spinner } from "../spinner";

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
      <div
        className="text-muted-foreground mt-4 flex items-center gap-2 text-sm"
        data-testid="connection-delete-impact-loading"
      >
        <Spinner />
        {t("connections.deleteImpact.loading")}
      </div>
    );
  }
  if (data.pins.length === 0 && data.schedules.length === 0) return null;

  return (
    <div
      className="mt-4 space-y-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200"
      data-testid="connection-delete-impact"
    >
      {data.pins.length > 0 && (
        <div>
          <p>{t("connections.pinImpact.intro", { count: data.pins.length })}</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {data.pins.map((pin) => (
              <li key={`${pin.agent_package_id}|${pin.integration_package_id}`}>
                <span className="font-medium">{pin.agent_display_name}</span>
                {" — "}
                {pin.connection_count > 1
                  ? t("connections.pinImpact.shrinks", {
                      count: pin.connection_count - 1,
                      from: pin.connection_count,
                    })
                  : t("connections.pinImpact.resets")}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.schedules.length > 0 && (
        <div>
          <p>{t("connections.scheduleImpact.intro", { count: data.schedules.length })}</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {data.schedules.map((schedule) => (
              <li key={`${schedule.scheduleId}|${schedule.integration_package_id}`}>
                <span className="font-medium">
                  {schedule.schedule_name ?? t("connections.scheduleImpact.unnamed")}
                </span>
                {` (${schedule.agent_display_name}) — `}
                {schedule.disables
                  ? t("connections.scheduleImpact.disables")
                  : schedule.connection_count > 1
                    ? t("connections.scheduleImpact.shrinks", {
                        count: schedule.connection_count - 1,
                        from: schedule.connection_count,
                      })
                    : t("connections.scheduleImpact.resets")}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
