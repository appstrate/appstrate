// SPDX-License-Identifier: Apache-2.0

import { ToneAlert } from "@/components/app-ui/status-variants";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@appstrate/ui/components/alert";
import { useIntegrationName } from "../hooks/use-integration-name";
import {
  type ConnectionChoice,
  type ConnectionRefusal,
  isChoiceRequest,
  refusalReasonKey,
} from "../lib/connection-choice";

/**
 * What a schedule save is still refused over, said once, at form level, because a picker row
 * may be missing (version detail unreadable, no `integrations:read`, no connectable auth). An
 * integration whose connection is left to choose is a request, not a fault: each is its own
 * informative alert, the choice under it being the form's state. Any other refusal is one
 * destructive list.
 */
export function ScheduleConnectionRefusals({
  choices,
  actorName,
}: {
  /** The refused integrations whose pick has not moved since the refusal. */
  choices: readonly ConnectionChoice[];
  /** Whose connections the schedule runs with; `null` while unread. */
  actorName: string | null;
}) {
  const { t } = useTranslation(["agents"]);
  const requests = choices.filter(isChoiceRequest);
  const refusals = choices.filter((c): c is ConnectionRefusal => !isChoiceRequest(c));
  return (
    <>
      {requests.map((choice) => (
        <ChoiceRequest key={choice.integrationId} choice={choice} actorName={actorName} />
      ))}
      {refusals.length > 0 && (
        <Alert variant="destructive" data-testid="schedule-connection-refusals">
          <AlertTriangle />
          <AlertTitle>{t("schedule.connectionOverrides.refusedTitle")}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-5 text-xs">
              {refusals.map((choice) => (
                <RefusalItem key={choice.integrationId} choice={choice} />
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}

function RefusalItem({ choice }: { choice: ConnectionRefusal }) {
  const { t } = useTranslation(["agents"]);
  const integration = useIntegrationName(choice.integrationId);
  return (
    <li>
      <span className="font-medium">{integration}</span>
      {" · "}
      {t(refusalReasonKey(choice))}
    </li>
  );
}

/**
 * A connection the schedule cannot settle by itself: it runs alone, nobody is there to be asked
 * which to use. With candidates the viewer picks one below; with none, only the actor (or an
 * admin's pin) can.
 */
function ChoiceRequest({
  choice,
  actorName,
}: {
  choice: ConnectionChoice;
  actorName: string | null;
}) {
  const { t } = useTranslation(["agents"]);
  const integration = useIntegrationName(choice.integrationId);
  const actor = actorName ?? t("schedule.connectionOverrides.actorFallback");
  const hasCandidates = choice.candidates.length > 0;
  const Icon = hasCandidates ? Info : AlertTriangle;
  return (
    <ToneAlert
      variant={hasCandidates ? "info" : "warning"}
      data-testid={`schedule-connection-request-${choice.integrationId}`}
    >
      <Icon />
      <AlertTitle>
        {hasCandidates
          ? t("schedule.connectionOverrides.choiceTitle", { integration, actor })
          : t("schedule.connectionOverrides.noCandidateTitle", { integration, actor })}
      </AlertTitle>
      <AlertDescription>
        {hasCandidates
          ? t("schedule.connectionOverrides.choiceBody", {
              integration,
              actor,
              count: choice.candidates.length,
            })
          : t("schedule.connectionOverrides.noCandidateBody", { integration, actor })}
      </AlertDescription>
    </ToneAlert>
  );
}
