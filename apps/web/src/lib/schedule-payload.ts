// SPDX-License-Identifier: Apache-2.0

import type { ModelGenerationSettings } from "@appstrate/core/model-generation";
import {
  withDeclaredConnections,
  withFallbackConnections,
  type FallbackBindingEntry,
} from "./connection-set";

/**
 * An execution identity. Exactly one field is set; `undefined` means no
 * selection. Mirrors the platform `actor` wire shape (user XOR end-user).
 */
export type ActorValue = { userId?: string; endUserId?: string };

export interface RunOverridesValue {
  /** Per-run model id override. */
  model_id_override?: string;
  /** Per-run/schedule generation layer. */
  generation_config_override?: ModelGenerationSettings;
  /** Per-run proxy id override. */
  proxy_id_override?: string;
  /**
   * Per-integration connection sets — the launch-override layer: a run's picks, or a
   * schedule's, replayed on every fire (a fire carries no run override). Beats member pins
   * and the soft default; under an admin pin or an enforced org default it may only name a
   * subset of that set, else the server refuses it (`override_outranked`).
   */
  connection_overrides?: Record<string, string[]>;
}

/** Whether two identities are the same one; `undefined` is no identity. */
export function sameActor(a: ActorValue | undefined, b: ActorValue | undefined): boolean {
  return (
    (a?.userId ?? null) === (b?.userId ?? null) && (a?.endUserId ?? null) === (b?.endUserId ?? null)
  );
}

/** The override half of a schedule create: an empty override is omitted, never `null`. */
interface ScheduleCreateOverrides {
  model_id_override?: string;
  generation_config_override?: ModelGenerationSettings;
  proxy_id_override?: string;
  version_override?: string;
  connection_overrides?: Record<string, string[]>;
  actor?: ActorValue;
}

/** The override half of a schedule edit: `null` clears an override, an absent key keeps it. */
interface ScheduleEditOverrides {
  model_id_override: string | null;
  generation_config_override: ModelGenerationSettings | null;
  proxy_id_override: string | null;
  version_override?: string | null;
  connection_overrides: Record<string, string[]> | null;
  actor?: ActorValue;
}

/** The fields both writes send; only the override half differs. */
interface ScheduleSaveFields {
  name?: string;
  cron_expression: string;
  timezone?: string;
  input?: Record<string, unknown>;
}

export type ScheduleCreateData = ScheduleSaveFields & ScheduleCreateOverrides;
export type ScheduleEditData = ScheduleSaveFields & { enabled?: boolean } & ScheduleEditOverrides;

/** The overrides a schedule form holds, and what a save derives the stored ones from. */
interface ScheduleOverridesState {
  overrides: RunOverridesValue;
  runsAsViewer: boolean;
  /** The viewer's readiness entries for the fired version. */
  viewerReadiness: readonly FallbackBindingEntry[] | undefined;
  /** The integrations the fired version declares; `undefined` while it loads. */
  declared: readonly string[] | undefined;
}

/**
 * What a schedule save stores. For a schedule running as the viewer, the connection the
 * fallback binds is named from `viewerReadiness`; for any other actor that verdict speaks for
 * nobody and names nothing. Then only the keys of `declared` are kept; `undefined` keeps every
 * pick.
 */
export function savedScheduleOverrides(state: ScheduleOverridesState): RunOverridesValue {
  return withDeclaredConnections(
    withFallbackConnections(
      state.overrides,
      state.runsAsViewer ? state.viewerReadiness : undefined,
    ),
    state.declared,
  );
}

interface ScheduleSaveArgs extends ScheduleOverridesState {
  fields: { name: string; cron_expression: string; timezone: string; enabled: boolean };
  /** What this schedule itself decides. Always sent: on edit `{}` releases the frozen values. */
  input: Record<string, unknown>;
  versionOverride: string | undefined;
  versionOverrideChanged: boolean;
  actor: ActorValue | undefined;
  currentActor: ActorValue | undefined;
}

/**
 * The body of a schedule write, from the form's state: the overrides as
 * {@link savedScheduleOverrides} stores them, and on an edit the version and actor only if changed.
 */
export function scheduleSavePayload(args: ScheduleSaveArgs & { isEdit: true }): ScheduleEditData;
export function scheduleSavePayload(args: ScheduleSaveArgs & { isEdit: false }): ScheduleCreateData;
export function scheduleSavePayload(
  args: ScheduleSaveArgs & { isEdit: boolean },
): ScheduleEditData | ScheduleCreateData {
  const { fields, versionOverride, actor } = args;
  const overrides = savedScheduleOverrides(args);
  const common = {
    name: fields.name || undefined,
    cron_expression: fields.cron_expression,
    timezone: fields.timezone,
    input: args.input,
  };
  if (args.isEdit) {
    return {
      ...common,
      enabled: fields.enabled,
      model_id_override: overrides.model_id_override ?? null,
      generation_config_override: overrides.generation_config_override ?? null,
      proxy_id_override: overrides.proxy_id_override ?? null,
      ...(args.versionOverrideChanged ? { version_override: versionOverride ?? null } : {}),
      connection_overrides: overrides.connection_overrides ?? null,
      ...(actor && !sameActor(actor, args.currentActor) ? { actor } : {}),
    };
  }
  return {
    ...common,
    ...(overrides.model_id_override ? { model_id_override: overrides.model_id_override } : {}),
    ...(overrides.generation_config_override
      ? { generation_config_override: overrides.generation_config_override }
      : {}),
    ...(overrides.proxy_id_override ? { proxy_id_override: overrides.proxy_id_override } : {}),
    ...(versionOverride ? { version_override: versionOverride } : {}),
    ...(overrides.connection_overrides
      ? { connection_overrides: overrides.connection_overrides }
      : {}),
    ...(actor ? { actor } : {}),
  };
}
