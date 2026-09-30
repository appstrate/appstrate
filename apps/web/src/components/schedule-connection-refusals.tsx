// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@appstrate/ui/components/alert";
import { type ConnectionChoice, refusalReasonKey } from "../lib/connection-choice";

/**
 * Every integration a schedule save is still refused over, with why — the one
 * place a refusal is spoken: at form level, because a picker row may be missing
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
    <Alert variant="destructive" data-testid="schedule-connection-refusals">
      <AlertTriangle />
      <AlertTitle>{t("schedule.connectionOverrides.refusedTitle")}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc space-y-1 pl-5 text-xs">
          {choices.map((choice) => (
            <li key={choice.integrationId}>
              <span className="font-mono">{choice.integrationId}</span>
              {" · "}
              {t(refusalReasonKey(choice))}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
