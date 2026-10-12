// SPDX-License-Identifier: Apache-2.0

import {
  INTEGRATION_MANIFEST_FAILURE_CODES,
  type MissingIntegrationConnectionCode,
} from "@appstrate/core/integration";
import { ApiError } from "../api/errors";
import type { components } from "../api/schema";

/** The integration package id an `integrations.{packageId}` error field names. */
export function integrationIdOfField(field: string): string {
  return field.slice("integrations.".length);
}

/** One `errors[]` item of a `409 missing_integration_connection`. */
export type MissingIntegrationFieldError = components["schemas"]["ConnectionResolutionItem"];

type ConnectionChoiceCandidate = NonNullable<
  MissingIntegrationFieldError["candidate_connections"]
>[number];

const SCHEDULE_CHOICE_CODES = [
  "must_choose_connection",
  "override_connection_unavailable",
  "auth_serves_no_selected_tool",
  "override_outranked",
  "required_integration_unbound",
] as const satisfies readonly MissingIntegrationConnectionCode[];

/**
 * An integration a schedule write was refused over. `candidates` are those the caller may
 * name — none when only the actor can choose. Only an edit of the schedule clears any of them.
 */
export interface ConnectionChoice {
  integrationId: string;
  code: (typeof SCHEDULE_CHOICE_CODES)[number];
  candidates: ConnectionChoiceCandidate[];
}

/** An integration refused for a reason no pick fixes alone (see `isChoiceRequest`). */
export type ConnectionRefusal = ConnectionChoice & {
  code: Exclude<ConnectionChoice["code"], "must_choose_connection">;
};

/** A connection the schedule cannot settle by itself: it asks for a choice rather than fails. */
export function isChoiceRequest(choice: ConnectionChoice): boolean {
  return choice.code === "must_choose_connection";
}

function isScheduleChoiceCode(
  code: MissingIntegrationConnectionCode,
): code is ConnectionChoice["code"] {
  return SCHEDULE_CHOICE_CODES.some((c) => c === code);
}

/** The `errors[]` of a `409 missing_integration_connection`; `null` for any other error. */
export function missingConnectionErrors(err: unknown): MissingIntegrationFieldError[] | null {
  if (!(err instanceof ApiError) || err.code !== "missing_integration_connection") return null;
  return (err.errors ?? []) as MissingIntegrationFieldError[];
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

/** Why an integration was refused, as an `agents` key. */
export function refusalReasonKey(choice: ConnectionRefusal): string {
  switch (choice.code) {
    case "override_connection_unavailable":
      return "schedule.connectionOverrides.unavailable";
    case "auth_serves_no_selected_tool":
      return "error.authServesNoSelectedTool";
    case "override_outranked":
      return "error.overrideOutranked";
    case "required_integration_unbound":
      return "error.requiredIntegrationUnbound";
  }
}

/** Verdicts raised before any account is looked at: no pick fixes them. */
const STRUCTURAL_CODES: ReadonlySet<MissingIntegrationConnectionCode> = new Set([
  "integration_not_active",
  "auth_key_serves_no_selected_tool",
  ...INTEGRATION_MANIFEST_FAILURE_CODES,
]);

export function isStructuralCode(code: MissingIntegrationConnectionCode): boolean {
  return STRUCTURAL_CODES.has(code);
}

/**
 * Re-run state of a refused launch: offered when a row can be answered, held while the launch is
 * in flight or `stillBlocking` names a refused integration (undefined = verdict not loaded,
 * nothing gated: the server stays the authority).
 */
export function retryDecision(
  errors: MissingIntegrationFieldError[],
  retrying: boolean,
  stillBlocking: readonly string[] | undefined,
): { showRetry: boolean; canRetry: boolean } {
  const blocked = (e: MissingIntegrationFieldError) =>
    stillBlocking?.includes(integrationIdOfField(e.field)) === true;
  return {
    showRetry: errors.some((e) => !isStructuralCode(e.code)),
    canRetry: !retrying && !errors.some(blocked),
  };
}
