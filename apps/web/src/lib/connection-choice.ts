// SPDX-License-Identifier: Apache-2.0

import { ApiError } from "../api/errors";
import type { components } from "../api/schema";
import type { ActorValue } from "../components/actor-select";
import type { MissingIntegrationFieldError } from "../components/missing-connections-modal";
import { sameActor } from "./schedule-payload";
import { sameSet } from "./strings";

/** The integration package id an `integrations.{packageId}` error field names. */
export function integrationIdOfField(field: string): string {
  return field.slice("integrations.".length);
}

export type ConnectionChoiceCandidate = NonNullable<
  components["schemas"]["ResolutionFieldError"]["candidate_connections"]
>[number];

/**
 * An integration a schedule write was refused over. `candidates` are those the caller may
 * name — none when only the actor can choose. Only an edit of the schedule clears any of them.
 */
export interface ConnectionChoice {
  integrationId: string;
  code:
    "must_choose_connection" | "override_connection_unavailable" | "auth_serves_no_selected_tool";
  candidates: ConnectionChoiceCandidate[];
}

const SCHEDULE_CHOICE_CODES: ReadonlySet<string> = new Set([
  "must_choose_connection",
  "override_connection_unavailable",
  "auth_serves_no_selected_tool",
]);

/** The `errors[]` of a `409 missing_integration_connection`; `null` for any other error. */
export function missingConnectionErrors(err: unknown): MissingIntegrationFieldError[] | null {
  if (!(err instanceof ApiError) || err.code !== "missing_integration_connection") return null;
  // `details` is typed as an open record; this code carries the `errors[]` array.
  return Array.isArray(err.details) ? (err.details as MissingIntegrationFieldError[]) : [];
}

export function scheduleConnectionChoices(err: unknown): ConnectionChoice[] {
  return (missingConnectionErrors(err) ?? [])
    .filter((e) => SCHEDULE_CHOICE_CODES.has(e.code))
    .map((e) => ({
      integrationId: integrationIdOfField(e.field),
      code: e.code as ConnectionChoice["code"],
      candidates: e.candidate_connections ?? [],
    }));
}

/**
 * The refused integrations whose current set is still the one the refused save sent. Derived,
 * so a mark clears as soon as the user picks — and comes back if they undo it.
 */
export function pendingConnectionChoices(
  choices: readonly ConnectionChoice[],
  submitted: Readonly<Record<string, string[]>> | null | undefined,
  current: Readonly<Record<string, string[]>> | null | undefined,
): ConnectionChoice[] {
  return choices.filter((c) =>
    sameSet(submitted?.[c.integrationId] ?? [], current?.[c.integrationId] ?? []),
  );
}

/** What a schedule save was sent with — what its refusal, if any, speaks for. */
export interface SubmittedPicks {
  runsAs: ActorValue | undefined;
  picks: Readonly<Record<string, string[]>>;
}

/** A refusal judged the identity the save was sent for: once the actor moves it is stale. */
export function refusalForActor(
  choices: readonly ConnectionChoice[] | undefined,
  submitted: SubmittedPicks | null,
  runsAs: ActorValue | undefined,
): readonly ConnectionChoice[] {
  return submitted && sameActor(submitted.runsAs, runsAs) ? (choices ?? []) : [];
}

/**
 * Picks name the previous identity's connections, so an actor change drops them — except back
 * on the schedule's stored actor (`stored`, edit only), whose stored picks hold again.
 */
export function picksAfterActorChange(args: {
  picks: Record<string, string[]> | undefined;
  runsAs: ActorValue | undefined;
  nextRunsAs: ActorValue | undefined;
  stored: { actor: ActorValue | undefined; picks: Record<string, string[]> | undefined } | null;
}): Record<string, string[]> | undefined {
  if (sameActor(args.nextRunsAs, args.runsAs)) return args.picks;
  return args.stored && sameActor(args.nextRunsAs, args.stored.actor)
    ? args.stored.picks
    : undefined;
}

/**
 * Why an integration was refused, as an `agents` key shared by the form-level alert and the
 * inline marks. An open choice with no candidate is one only the actor (or an admin pin) can make.
 */
export function refusalReasonKey(choice: ConnectionChoice): string {
  switch (choice.code) {
    case "override_connection_unavailable":
      return "schedule.connectionOverrides.unavailable";
    case "auth_serves_no_selected_tool":
      return "schedule.connectionOverrides.unserving";
    case "must_choose_connection":
      return choice.candidates.length > 0
        ? "schedule.connectionOverrides.mustChoose"
        : "schedule.connectionOverrides.actorMustChoose";
  }
}
