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
export type MissingIntegrationFieldError = components["schemas"]["ResolutionFieldError"];

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

function isScheduleChoiceCode(code: string): code is ConnectionChoice["code"] {
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
    case "required_integration_unbound":
      return "error.requiredIntegrationUnbound";
    case "must_choose_connection":
      return choice.candidates.length > 0
        ? "schedule.connectionOverrides.mustChoose"
        : "schedule.connectionOverrides.actorMustChoose";
  }
}

/** Per-run picks in the run route's `connection_overrides` shape (`launch-schemas.ts`). */
export type ConnectionOverridesMap = Record<string, string[]>;

/** Verdicts raised before any account is looked at: no pick fixes them. */
const STRUCTURAL_CODES: ReadonlySet<string> = new Set([
  "integration_not_active",
  "auth_key_serves_no_selected_tool",
  ...INTEGRATION_MANIFEST_FAILURE_CODES,
] satisfies MissingIntegrationConnectionCode[]);

export function isStructuralCode(code: string): boolean {
  return STRUCTURAL_CODES.has(code);
}

/** Re-run state: a `must_choose_connection` row waits for a pick (`[]` counts), others don't. */
export function retryDecision(
  errors: MissingIntegrationFieldError[],
  picks: ConnectionOverridesMap,
  retrying = false,
): { mustChoose: boolean; showRetry: boolean; canRetry: boolean } {
  const mustChooseIds = errors
    .filter((e) => e.code === "must_choose_connection")
    .map((e) => integrationIdOfField(e.field));
  return {
    mustChoose: mustChooseIds.length > 0,
    showRetry: errors.some((e) => !isStructuralCode(e.code)),
    canRetry: !retrying && mustChooseIds.every((id) => picks[id] !== undefined),
  };
}
