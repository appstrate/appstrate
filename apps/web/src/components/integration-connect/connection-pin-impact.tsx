// SPDX-License-Identifier: Apache-2.0

/**
 * Which of the caller's agents lose the connection a delete removes: the delete
 * drops it from their own member pins, so an agent bound to several connections
 * keeps running on the rest — said here, before the user confirms, rather than
 * discovered on the next run. Mount only while the confirmation is open.
 */

import { useTranslation } from "react-i18next";
import { $api } from "../../api/client";

export function ConnectionPinImpact({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation("settings");
  const { data } = $api.useQuery(
    "get",
    "/api/me/connections/{connectionId}/pins",
    { params: { path: { connectionId } } },
    { select: (e) => e.data },
  );
  if (!data || data.length === 0) return null;

  return (
    <div
      className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200"
      data-testid="connection-pin-impact"
    >
      <p>{t("connections.pinImpact.intro", { count: data.length })}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {data.map((pin) => (
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
  );
}
