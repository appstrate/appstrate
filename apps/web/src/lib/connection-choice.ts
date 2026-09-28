// SPDX-License-Identifier: Apache-2.0

import { ApiError } from "../api/errors";
import type { ActorValue } from "../components/actor-select";
import { sameActor } from "./schedule-payload";

/** The integration package id an `integrations.{packageId}` error field names. */
export function integrationIdOfField(field: string): string {
  return field.slice("integrations.".length);
}

/** One connection a `must_choose_connection` item offers, as judged for the run's actor. */
export interface ConnectionChoiceCandidate {
  id: string;
  label: string;
  account_id: string;
  owned_by_actor: boolean;
  needs_reconnection: boolean;
}

/**
 * An integration a schedule write was refused over: nothing chosen where a fire
 * cannot decide alone (`must_choose_connection`, with the candidates the caller
 * may name — none when only the actor can choose), a chosen connection the actor
 * cannot reach (`override_connection_unavailable`), or one on an auth serving
 * none of the selected tools (`auth_serves_no_selected_tool`). Only an edit of
 * the schedule clears any of them.
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

/**
 * The connection choices a `409 missing_integration_connection` from a
 * schedule write asks for. Empty for any other error.
 */
export function scheduleConnectionChoices(err: unknown): ConnectionChoice[] {
  if (!(err instanceof ApiError) || err.code !== "missing_integration_connection") return [];
  // `details` is typed as an open record; this code carries the `errors[]` array.
  const items: unknown = err.details;
  if (!Array.isArray(items)) return [];
  return items
    .filter((e) => SCHEDULE_CHOICE_CODES.has(e?.code) && typeof e.field === "string")
    .map(
      (e: { field: string; code: ConnectionChoice["code"]; candidate_connections?: unknown }) => ({
        integrationId: integrationIdOfField(e.field),
        code: e.code,
        candidates: Array.isArray(e.candidate_connections)
          ? (e.candidate_connections as ConnectionChoiceCandidate[])
          : [],
      }),
    );
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/**
 * The refused integrations still awaiting a new pick: those whose current set is
 * still the one the refused save sent (empty for an open choice, the unreachable
 * set for an unavailable one). Derived, so a mark clears as soon as the user
 * picks — and comes back if they undo it.
 */
export function pendingConnectionChoices(
  choices: readonly ConnectionChoice[],
  submitted: Readonly<Record<string, string[]>> | null | undefined,
  current: Readonly<Record<string, string[]>> | null | undefined,
): ConnectionChoice[] {
  return choices.filter((c) =>
    sameIds(current?.[c.integrationId] ?? [], submitted?.[c.integrationId] ?? []),
  );
}

/** What a schedule save was sent with — what its refusal, if any, speaks for. */
export interface SubmittedPicks {
  runsAs: ActorValue | undefined;
  picks: Readonly<Record<string, string[]>>;
}

/**
 * The refusal still in force: it judged the identity the save was sent for, so
 * once the actor moves it is stale — neither shown nor gating.
 */
export function refusalForActor(
  choices: readonly ConnectionChoice[] | undefined,
  submitted: SubmittedPicks | null,
  runsAs: ActorValue | undefined,
): readonly ConnectionChoice[] {
  return submitted && sameActor(submitted.runsAs, runsAs) ? (choices ?? []) : [];
}

/**
 * The picks a schedule form holds once its actor changes. They named the
 * previous identity's connections, so a real change drops them — except back on
 * the schedule's stored actor (`stored`, edit only), whose stored picks hold again.
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
 * Why an integration was refused, as an `agents` key — one wording for the
 * form-level alert and the inline marks. An open choice with no candidate
 * offered is one only the actor (or an admin pin) can make.
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
