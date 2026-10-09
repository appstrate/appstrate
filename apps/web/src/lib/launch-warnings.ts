// SPDX-License-Identifier: Apache-2.0

import i18n from "../i18n";
import type { components } from "../api/schema";
import { integrationIdOfField } from "./connection-choice";

/** One `warnings[]` item (`integration_unbound` | `integration_not_active`). */
export type LaunchWarning = components["schemas"]["ResolutionFieldError"];

/** A run (always the viewer's), or a schedule running as `userId`. */
export type LaunchTarget = { kind: "run" } | { kind: "schedule"; userId: string | null };

/** Whether the run binds the VIEWER's connections, the only ones the Connexions tab offers. */
export function isViewersLaunch(target: LaunchTarget, viewerId: string | undefined): boolean {
  return target.kind === "run" || (target.userId !== null && target.userId === viewerId);
}

// Full literal keys: the locale guard cannot see a key built from a template string.
const MESSAGE_KEYS = { run: "launchWarnings.run", schedule: "launchWarnings.schedule" } as const;
const CAUSE_KEYS = {
  notConnected: "launchWarnings.cause.notConnected",
  otherAuthMethod: "launchWarnings.cause.otherAuthMethod",
  sharedOnly: "launchWarnings.cause.sharedOnly",
  inactive: "launchWarnings.cause.inactive",
  other: "launchWarnings.cause.other",
} as const;
type WarningCause = keyof typeof CAUSE_KEYS;

function causeOf(w: LaunchWarning): WarningCause {
  if (w.code === "integration_not_active") return "inactive";
  if ((w.candidate_connections?.length ?? 0) > 0) return "sharedOnly";
  if (w.required_auth_key !== undefined) return "otherAuthMethod";
  // Without a connect target, it may be a deliberate "no connection".
  if (w.auth_key !== undefined) return "notConnected";
  return "other";
}

/** Each warned integration, once, in the server's order, with its first item's cause. */
function causesOf(warnings: readonly LaunchWarning[]): Map<string, WarningCause> {
  const causes = new Map<string, WarningCause>();
  for (const w of warnings) {
    if (!w.field.startsWith("integrations.")) continue;
    const id = integrationIdOfField(w.field);
    if (!causes.has(id)) causes.set(id, causeOf(w));
  }
  return causes;
}

/** Whether {@link launchWarningsToast} has anything to say. */
export function hasLaunchWarnings(warnings: readonly LaunchWarning[]): boolean {
  return causesOf(warnings).size > 0;
}

/** The one toast a launch's warnings make, or `null` when there is nothing to say. */
export function launchWarningsToast(input: {
  kind: LaunchTarget["kind"];
  warnings: readonly LaunchWarning[];
  nameOf: (integrationId: string) => string;
}): { message: string; description: string; connectable: boolean } | null {
  const causes = causesOf(input.warnings);
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
    connectable:
      distinct.has("notConnected") || distinct.has("otherAuthMethod") || distinct.has("sharedOnly"),
  };
}
