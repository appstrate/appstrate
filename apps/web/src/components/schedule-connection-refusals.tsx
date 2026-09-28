// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { type ConnectionChoice, refusalReasonKey } from "../lib/connection-choice";

/**
 * Every integration a schedule save is still refused over, with why — at form
 * level, because an inline mark needs a rendered row, and a row may be missing
 * (version detail unreadable, no `integrations:read`, no connectable auth).
 */
export function ScheduleConnectionRefusals({
  choices,
}: {
  /** The refused integrations whose pick has not moved since the refusal. */
  choices: readonly ConnectionChoice[];
}) {
  const { t } = useTranslation(["agents"]);
  if (choices.length === 0) return null;
  return (
    <div
      className="border-destructive/40 bg-destructive/10 text-destructive space-y-2 rounded-md border p-3 text-sm"
      role="alert"
      data-testid="schedule-connection-refusals"
    >
      <p className="font-medium">{t("schedule.connectionOverrides.refusedTitle")}</p>
      <ul className="list-disc space-y-1 pl-5 text-xs">
        {choices.map((choice) => (
          <li key={choice.integrationId}>
            <span className="font-mono">{choice.integrationId}</span>
            {" — "}
            {t(refusalReasonKey(choice))}
          </li>
        ))}
      </ul>
    </div>
  );
}
