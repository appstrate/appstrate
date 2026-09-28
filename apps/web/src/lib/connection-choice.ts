// SPDX-License-Identifier: Apache-2.0

import { ApiError } from "../api/errors";

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
 * cannot decide alone (`must_choose_connection`, with the actor's candidates), or
 * a chosen connection the actor cannot reach (`override_connection_unavailable`).
 * Only an edit of the schedule clears either.
 */
export interface ConnectionChoice {
  integrationId: string;
  code: "must_choose_connection" | "override_connection_unavailable";
  candidates: ConnectionChoiceCandidate[];
}

const SCHEDULE_CHOICE_CODES: ReadonlySet<string> = new Set([
  "must_choose_connection",
  "override_connection_unavailable",
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
