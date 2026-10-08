// SPDX-License-Identifier: Apache-2.0

import { ApiError } from "../api/errors";
import type { components } from "../api/schema";
import { type ActorValue, sameActor } from "./schedule-payload";
import { sameSet } from "./strings";

/** The integration package id an `integrations.{packageId}` error field names. */
export function integrationIdOfField(field: string): string {
  return field.slice("integrations.".length);
}

/** One `errors[]` item of a `409 missing_integration_connection`. */
export type MissingIntegrationFieldError = components["schemas"]["ResolutionFieldError"];

type ConnectionChoiceCandidate = NonNullable<
  MissingIntegrationFieldError["candidate_connections"]
>[number];

const SCHEDULE_CHOICE_CODES = [
  "must_choose_connection",
  "override_connection_unavailable",
  "auth_serves_no_selected_tool",
  "override_outranked",
] as const;

/**
 * An integration a schedule write was refused over. `candidates` are those the caller may
 * name — none when only the actor can choose. Only an edit of the schedule clears any of them.
 */
export interface ConnectionChoice {
  integrationId: string;
  code: (typeof SCHEDULE_CHOICE_CODES)[number];
  candidates: ConnectionChoiceCandidate[];
}

function isScheduleChoiceCode(code: string): code is ConnectionChoice["code"] {
  return SCHEDULE_CHOICE_CODES.some((c) => c === code);
}

/** The `errors[]` of a `409 missing_integration_connection`; `null` for any other error. */
export function missingConnectionErrors(err: unknown): MissingIntegrationFieldError[] | null {
  if (!(err instanceof ApiError) || err.code !== "missing_integration_connection") return null;
  // `details` is typed as an open record; this code carries the `errors[]` array.
  return Array.isArray(err.details) ? (err.details as MissingIntegrationFieldError[]) : [];
}

export function scheduleConnectionChoices(err: unknown): ConnectionChoice[] {
  return (missingConnectionErrors(err) ?? []).flatMap((e) =>
    isScheduleChoiceCode(e.code)
      ? [
          {
            integrationId: integrationIdOfField(e.field),
            code: e.code,
            candidates: e.candidate_connections ?? [],
          },
        ]
      : [],
  );
}

/**
 * The refused integrations whose current set is still the one the refused save sent — no pick
 * and "no connection" (`[]`) are different answers. Derived, so a mark clears as soon as the
 * user picks — and comes back if they undo it.
 */
export function pendingConnectionChoices(
  choices: readonly ConnectionChoice[],
  submitted: Readonly<Record<string, string[]>> | null | undefined,
  current: Readonly<Record<string, string[]>> | null | undefined,
): ConnectionChoice[] {
  return choices.filter((c) => {
    const sent = submitted?.[c.integrationId];
    const now = current?.[c.integrationId];
    return sent === undefined || now === undefined ? sent === now : sameSet(sent, now);
  });
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
 * Why an integration was refused, as an `agents` key. An open choice with no candidate is one
 * only the actor (or an admin pin) can make.
 */
export function refusalReasonKey(choice: ConnectionChoice): string {
  switch (choice.code) {
    case "override_connection_unavailable":
      return "schedule.connectionOverrides.unavailable";
    case "auth_serves_no_selected_tool":
      return "error.authServesNoSelectedTool";
    case "override_outranked":
      return "error.overrideOutranked";
    case "must_choose_connection":
      return choice.candidates.length > 0
        ? "schedule.connectionOverrides.mustChoose"
        : "schedule.connectionOverrides.actorMustChoose";
  }
}
