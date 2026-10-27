// SPDX-License-Identifier: Apache-2.0

import {
  INTEGRATION_MANIFEST_FAILURE_CODES,
  type MissingIntegrationConnectionCode,
} from "@appstrate/core/integration";
import { ApiError } from "../api/errors";
import type { components } from "../api/schema";
import { withConnectionOverride, type ConnectionSet } from "./connection-set";
import { type ActorValue, type RunOverridesValue, sameActor } from "./schedule-payload";
import { sameSet } from "./strings";

export function integrationIdOfField(field: string): string {
  return field.slice("integrations.".length);
}

/** One `errors[]` item of a `409 missing_integration_connection`. */
export type MissingIntegrationFieldError = components["schemas"]["ConnectionResolutionItem"];

export type ConnectionChoiceCandidate = NonNullable<
  MissingIntegrationFieldError["candidate_connections"]
>[number];

/**
 * What tells candidates apart: the account, whether another member shared it, whether it is dead.
 * `labels` are the translated phrases, so the wording stays with the caller.
 */
export function candidateDescription(
  c: Pick<ConnectionChoiceCandidate, "account_id" | "owned_by_actor" | "needs_reconnection">,
  labels: { sharedByOther: string; needsReconnection: string },
): string {
  return [
    // "default" is the placeholder of a connection with no account identity.
    c.account_id !== "default" ? c.account_id : null,
    !c.owned_by_actor ? labels.sharedByOther : null,
    c.needs_reconnection ? labels.needsReconnection : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/** A candidate as a single-choice option; a dead connection fails the run it is picked for. */
export function candidateSelectOption(
  c: ConnectionChoiceCandidate,
  labels: { sharedByOther: string; needsReconnection: string },
): { value: string; label: string; disabled: boolean } {
  const description = candidateDescription(c, labels);
  return {
    value: c.id,
    label: description ? `${c.label} · ${description}` : c.label,
    disabled: c.needs_reconnection,
  };
}

const SCHEDULE_CHOICE_CODES = [
  "must_choose_connection",
  "override_connection_unavailable",
  "auth_serves_no_selected_tool",
  "override_outranked",
  "connection_set_too_large",
  "required_integration_unbound",
] as const satisfies readonly MissingIntegrationConnectionCode[];

/** `candidates`: those the caller may name; none when only the actor can choose. */
export interface ConnectionChoice {
  integrationId: string;
  code: (typeof SCHEDULE_CHOICE_CODES)[number];
  candidates: ConnectionChoiceCandidate[];
}

export type ConnectionRefusal = ConnectionChoice & {
  code: Exclude<ConnectionChoice["code"], "must_choose_connection">;
};

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

/** Refused integrations whose current set is still the one the refused save sent (no pick and `[]` differ). */
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
 * `overrides` with a pick made for `pickedAs`, unchanged once the schedule runs as someone else:
 * a pick names its actor's connections, and a connect popup settles long after it was opened.
 */
export function withConnectionPickAs(
  overrides: RunOverridesValue,
  pick: {
    pickedAs: ActorValue | undefined;
    runsAs: ActorValue | undefined;
    integrationId: string;
    connectionIds: ConnectionSet;
  },
): RunOverridesValue {
  return sameActor(pick.pickedAs, pick.runsAs)
    ? withConnectionOverride(overrides, pick.integrationId, pick.connectionIds)
    : overrides;
}

export function refusalReasonKey(choice: ConnectionRefusal): string {
  switch (choice.code) {
    case "override_connection_unavailable":
      return "schedule.connectionOverrides.unavailable";
    case "auth_serves_no_selected_tool":
      return "error.authServesNoSelectedTool";
    case "override_outranked":
      return "error.overrideOutranked";
    case "connection_set_too_large":
      return "error.connectionSetTooLarge";
    case "required_integration_unbound":
      return "error.requiredIntegrationUnbound";
  }
}

/** Verdicts raised before any account is looked at: no pick fixes them. */
const STRUCTURAL_CODES: ReadonlySet<MissingIntegrationConnectionCode> = new Set([
  "integration_not_active",
  "auth_key_serves_no_selected_tool",
  "auth_key_on_unauthenticated_integration",
  ...INTEGRATION_MANIFEST_FAILURE_CODES,
]);

export function isStructuralCode(code: MissingIntegrationConnectionCode): boolean {
  return STRUCTURAL_CODES.has(code);
}

/** Held while in flight or `stillBlocking` names a refused integration (undefined = not loaded, nothing gated). */
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
