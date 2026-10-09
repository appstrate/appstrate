// SPDX-License-Identifier: Apache-2.0

import type {
  ConnectionResolutionSource,
  ConnectionResolutionWarningCode,
} from "@appstrate/core/integration";
import i18n from "../i18n";
import type { components } from "../api/schema";
import { integrationIdOfField } from "./connection-choice";

/** One `warnings[]` item: an integration the run starts without, and why. */
export type LaunchWarning = components["schemas"]["ConnectionResolutionWarning"];

/** A run (always the viewer's), or a schedule running as `userId`. */
export type LaunchTarget = { kind: "run" } | { kind: "schedule"; userId: string | null };

/** Whether the run binds the VIEWER's connections, the only ones the Connexions tab offers. */
export function isViewersLaunch(target: LaunchTarget, viewerId: string | undefined): boolean {
  return target.kind === "run" || (target.userId !== null && target.userId === viewerId);
}

/** The layers that can choose `[]`: an org default is never empty, and the fallback binds. */
type NoneChoosingSource = Exclude<
  ConnectionResolutionSource,
  "org_default" | "org_default_enforced" | "fallback_auto"
>;

const NONE_CHOSEN_BY_KEYS = {
  admin_pin: "noneChosenBy.adminPin",
  run_override: "noneChosenBy.runOverride",
  schedule_override: "noneChosenBy.scheduleOverride",
  member_pin: "noneChosenBy.memberPin",
} as const satisfies Record<NoneChoosingSource, string>;

/** Every layer that can choose `[]`. */
export const NONE_CHOOSING_SOURCES = Object.keys(NONE_CHOSEN_BY_KEYS) as NoneChoosingSource[];

const choosesNone = (source: ConnectionResolutionSource): source is NoneChoosingSource =>
  source in NONE_CHOSEN_BY_KEYS;

/** The layer that chose no connection, as an `agents` phrase; `null` when none is named. */
export function noneChosenBy(source: ConnectionResolutionSource | null | undefined): string | null {
  if (!source || !choosesNone(source)) return null;
  return i18n.t(NONE_CHOSEN_BY_KEYS[source], { ns: "agents" });
}

// Full literal keys: the locale guard cannot see a key built from a template string.
const MESSAGE_KEYS = { run: "launchWarnings.run", schedule: "launchWarnings.schedule" } as const;
const CAUSES = {
  not_connected: { key: "launchWarnings.cause.notConnected", connectable: true },
  must_choose_connection: { key: "launchWarnings.cause.sharedOnly", connectable: true },
  auth_key_mismatch: { key: "launchWarnings.cause.otherAuthMethod", connectable: true },
  integration_not_active: { key: "launchWarnings.cause.inactive", connectable: false },
  integration_unbound: { key: "launchWarnings.cause.chosenNone", connectable: false },
} as const satisfies Record<ConnectionResolutionWarningCode, { key: string; connectable: boolean }>;

/** Each warned integration, once, in the server's order, with its first item. */
function warningsByIntegration(warnings: readonly LaunchWarning[]): Map<string, LaunchWarning> {
  const byId = new Map<string, LaunchWarning>();
  for (const w of warnings) {
    if (!w.field.startsWith("integrations.")) continue;
    const id = integrationIdOfField(w.field);
    if (!byId.has(id)) byId.set(id, w);
  }
  return byId;
}

/** Why integrations started without a connection, for warnings sharing one cause. */
export function causeSentence(
  w: { code: ConnectionResolutionWarningCode; source?: ConnectionResolutionSource | null },
  count = 1,
): string {
  const by = w.code === "integration_unbound" ? noneChosenBy(w.source) : null;
  return by
    ? i18n.t("launchWarnings.cause.chosenNoneBy", { ns: "agents", count, by })
    : i18n.t(CAUSES[w.code].key, { ns: "agents", count });
}

/** The integrations {@link launchWarningsToast} names; empty when it has nothing to say. */
export function warnedIntegrationIds(warnings: readonly LaunchWarning[]): string[] {
  return [...warningsByIntegration(warnings).keys()];
}

/** The one toast a launch's warnings make, or `null` when there is nothing to say. */
export function launchWarningsToast(input: {
  kind: LaunchTarget["kind"];
  warnings: readonly LaunchWarning[];
  nameOf: (integrationId: string) => string;
}): { message: string; description: string; connectable: boolean } | null {
  const byId = warningsByIntegration(input.warnings);
  const items = [...byId.values()];
  const [first] = items;
  if (!first) return null;
  const count = items.length;
  const oneCause = items.every((w) => w.code === first.code && w.source === first.source);
  return {
    message: i18n.t(MESSAGE_KEYS[input.kind], {
      ns: "agents",
      count,
      names: [...byId.keys()].map(input.nameOf).join(", "),
    }),
    description: oneCause
      ? causeSentence(first, count)
      : i18n.t("launchWarnings.cause.other", { ns: "agents", count }),
    connectable: items.some((w) => CAUSES[w.code].connectable),
  };
}
