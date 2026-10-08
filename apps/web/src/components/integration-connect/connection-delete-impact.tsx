// SPDX-License-Identifier: Apache-2.0

/**
 * What a delete rewrites among the caller's own member pins and schedule overrides, said
 * before the user confirms. Mount only while the confirmation is open.
 */

import { useTranslation } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "@appstrate/ui/components/alert";
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
    <Alert variant="warning" className="mt-4" data-testid="connection-delete-impact">
      <AlertTitle>{t("connections.impact.title")}</AlertTitle>
      <AlertDescription>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {data.pins.map((pin) => (
            <li key={`${pin.agent_package_id}|${pin.integration_package_id}`}>
              <span className="font-medium">{pin.agent_display_name}</span>
              {" : "}
              {pin.connection_count > 1
                ? t("connections.impact.shrinks", {
                    count: pin.connection_count - 1,
                    from: pin.connection_count,
                  })
                : t("connections.impact.agentResets")}
            </li>
          ))}
          {data.schedules.map((schedule) => (
            <li key={`${schedule.scheduleId}|${schedule.integration_package_id}`}>
              <span className="font-medium">
                {schedule.schedule_name ?? t("connections.scheduleImpact.unnamed")}
              </span>
              {` (${schedule.agent_display_name}) : `}
              {schedule.disables
                ? t("connections.impact.scheduleDisables")
                : schedule.connection_count > 1
                  ? t("connections.impact.shrinks", {
                      count: schedule.connection_count - 1,
                      from: schedule.connection_count,
                    })
                  : t("connections.impact.scheduleResets")}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
