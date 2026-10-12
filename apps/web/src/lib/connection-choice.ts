// SPDX-License-Identifier: Apache-2.0

import {
  INTEGRATION_MANIFEST_FAILURE_CODES,
  type MissingIntegrationConnectionCode,
} from "@appstrate/core/integration";
import { ApiError } from "../api/errors";
import type { components } from "../api/schema";
import { withConnectionOverride } from "./connection-set";
import { type ActorValue, type RunOverridesValue, sameActor } from "./schedule-payload";
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
 * The refused integrations whose current set is still the one the refused save sent (no pick and
 * `[]` differ). Derived, so a mark clears as soon as the user picks — and comes back on undo.
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

/** What {@link withDefaultConnections} reads of one integration's readiness entry. */
interface DefaultBindingEntry {
  integration_package_id: string;
  resolution: Pick<
    components["schemas"]["IntegrationAgentResolution"],
    "source" | "error_code" | "resolved_connection_ids"
  >;
}

/**
 * `overrides` as a schedule running as the viewer holds them: each integration with no pick
 * (`[]` is one) stands on what readiness binds by default (`fallback_auto`, the actor's one own
 * connection), which an armed schedule write wants named. A pin or an org default names its own
 * set, and the verdict judges the viewer only.
 */
export function withDefaultConnections(
  overrides: RunOverridesValue,
  args: { actorIsViewer: boolean; readiness: readonly DefaultBindingEntry[] | undefined },
): RunOverridesValue {
  if (!args.actorIsViewer) return overrides;
  let next = overrides;
  for (const { integration_package_id: id, resolution } of args.readiness ?? []) {
    const { source, error_code: code, resolved_connection_ids: bound } = resolution;
    if (source !== "fallback_auto" || code !== null || bound.length === 0) continue;
    if (next.connection_overrides?.[id] !== undefined) continue;
    next = withConnectionOverride(next, id, bound);
  }
  return next;
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
