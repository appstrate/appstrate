// SPDX-License-Identifier: Apache-2.0

import { type ConnectionChoice, pendingConnectionChoices } from "../lib/connection-choice";
import type { ConnectionSet } from "../lib/connection-set";
import { ScheduleActorConnectionChoice } from "./schedule-actor-connection-choice";
import { ScheduleConnectionRefusals } from "./schedule-connection-refusals";

/**
 * The answer to a schedule write refused over connections (`409 missing_integration_connection`):
 * why each integration was refused — said until its pick moves — and the picks that answer it.
 * Every refusal is shown, a destructive one too (`override_outranked`,
 * `required_integration_unbound`): a picker alone would leave it unexplained.
 */
export function ScheduleConnectionAnswer({
  choices,
  submitted,
  value,
  integrations,
  actorName,
  onChange,
}: {
  choices: readonly ConnectionChoice[];
  /** The picks the refused write was judged with. */
  submitted: Readonly<Record<string, string[]>>;
  value: Readonly<Record<string, string[]>>;
  /** The integrations the refused write fires. */
  integrations: readonly { id: string; required?: boolean }[];
  actorName: string | null;
  onChange: (integrationId: string, connectionIds: ConnectionSet) => void;
}) {
  return (
    <div className="space-y-4" data-testid="schedule-connection-answer">
      <ScheduleConnectionRefusals
        choices={pendingConnectionChoices(choices, submitted, value)}
        actorName={actorName}
      />
      <ScheduleActorConnectionChoice
        choices={choices}
        integrations={integrations}
        value={value}
        // The alerts above have just said whose connections these are.
        showContext={false}
        onChange={onChange}
      />
    </div>
  );
}
