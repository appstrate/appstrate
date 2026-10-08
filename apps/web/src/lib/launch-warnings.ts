// SPDX-License-Identifier: Apache-2.0

import i18n from "../i18n";
import type { components } from "../api/schema";
import { integrationIdOfField } from "./connection-choice";

/**
 * One `warnings[]` item of a launch or schedule write: an integration the run starts without.
 * The shared item shape; its `code` is `integration_unbound` or `integration_not_active`.
 */
export type LaunchWarning = components["schemas"]["ResolutionFieldError"];

/** A run starts now; a schedule's fires will. */
type LaunchKind = "run" | "schedule";

/** What was launched: a run (always the viewer's), or a schedule running as `userId`. */
export type LaunchTarget = { kind: "run" } | { kind: "schedule"; userId: string | null };

/**
 * Whether the run resolves the VIEWER's connections — the only ones the Connexions tab offers.
 * Another member's schedule gets no warnings at all; an end-user's does, and is not the viewer's.
 */
export function isViewersLaunch(target: LaunchTarget, viewerId: string | undefined): boolean {
  return target.kind === "run" || (target.userId !== null && target.userId === viewerId);
}

/** Why the run starts without an integration, as far as the item says. */
type WarningCause = "notConnected" | "sharedOnly" | "inactive" | "other";

const MESSAGE_KEYS: Record<LaunchKind, string> = {
  run: "launchWarnings.run",
  schedule: "launchWarnings.schedule",
};

const CAUSE_KEYS: Record<WarningCause, string> = {
  notConnected: "launchWarnings.cause.notConnected",
  sharedOnly: "launchWarnings.cause.sharedOnly",
  inactive: "launchWarnings.cause.inactive",
  other: "launchWarnings.cause.other",
};

function causeOf(w: LaunchWarning): WarningCause {
  if (w.code === "integration_not_active") return "inactive";
  if ((w.candidate_connections?.length ?? 0) > 0) return "sharedOnly";
  // A connect target or an auth mismatch: nothing usable. Without either, a deliberate
  // "no connection" or a cause the item does not name — said neutrally.
  if (w.auth_key !== undefined || w.required_auth_key !== undefined) return "notConnected";
  return "other";
}

interface LaunchWarningsToast {
  message: string;
  description: string;
  /** Some integration a connection would bring back: worth sending to the Connexions tab. */
  connectable: boolean;
}

/** The one toast a launch's warnings make, or `null` when there is nothing to say. */
export function launchWarningsToast(input: {
  kind: LaunchKind;
  warnings: readonly LaunchWarning[] | undefined;
  /** Display name of an integration package id. */
  nameOf: (integrationId: string) => string;
}): LaunchWarningsToast | null {
  const causes = new Map<string, WarningCause>();
  for (const w of input.warnings ?? []) {
    if (!w.field.startsWith("integrations.")) continue;
    const id = integrationIdOfField(w.field);
    if (!causes.has(id)) causes.set(id, causeOf(w));
  }
  if (causes.size === 0) return null;
  const count = causes.size;
  const distinct = new Set(causes.values());
  const cause = distinct.size === 1 ? [...distinct][0]! : "other";
  return {
    message: i18n.t(MESSAGE_KEYS[input.kind], {
      ns: "agents",
      count,
      names: [...causes.keys()].map(input.nameOf).join(", "),
    }),
    description: i18n.t(CAUSE_KEYS[cause], { ns: "agents", count }),
    connectable: [...causes.values()].some((c) => c === "notConnected" || c === "sharedOnly"),
  };
}
