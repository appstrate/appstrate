// SPDX-License-Identifier: Apache-2.0

/**
 * What a delete rewrites among the caller's own references: it drops the
 * connection from their member pins and schedule overrides, so an agent or a
 * schedule bound to several connections keeps running on the rest — said here,
 * before the user confirms, rather than discovered on the next run. Mount only
 * while the confirmation is open.
 */

import { useTranslation } from "react-i18next";
import { $api } from "../../api/client";

export function ConnectionDeleteImpact({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation("settings");
  const { data } = $api.useQuery(
    "get",
    "/api/me/connections/{connectionId}/delete-impact",
    { params: { path: { connectionId } } },
    // Never answered from cache: the user confirms on what this says, and a
    // pick made since the last open would be missing from it.
    { gcTime: 0 },
  );
  if (!data || (data.pins.length === 0 && data.schedules.length === 0)) return null;

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
                {schedule.connection_count > 1
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
