// SPDX-License-Identifier: Apache-2.0

import type { ModelGenerationSettings } from "@appstrate/core/model-generation";

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
export interface ScheduleCreateOverrides {
  model_id_override?: string;
  generation_config_override?: ModelGenerationSettings;
  proxy_id_override?: string;
  version_override?: string;
  connection_overrides?: Record<string, string[]>;
  actor?: ActorValue;
}

/** The override half of a schedule edit: `null` clears an override, an absent key keeps it. */
export interface ScheduleEditOverrides {
  model_id_override: string | null;
  generation_config_override: ModelGenerationSettings | null;
  proxy_id_override: string | null;
  version_override?: string | null;
  connection_overrides: Record<string, string[]> | null;
  actor?: ActorValue;
}

interface ScheduleOverrideArgs {
  overrides: RunOverridesValue;
  versionOverride: string | undefined;
  versionOverrideChanged: boolean;
  actor: ActorValue | undefined;
  currentActor: ActorValue | undefined;
}

/**
 * The override half of a schedule write. Create omits whatever is empty. Edit sends every
 * override, `null` for a cleared one (an absent key leaves the row untouched), except
 * `version_override` and the actor, sent only when they changed.
 */
export function scheduleOverridePayload(
  args: ScheduleOverrideArgs & { isEdit: true },
): ScheduleEditOverrides;
export function scheduleOverridePayload(
  args: ScheduleOverrideArgs & { isEdit: false },
): ScheduleCreateOverrides;
export function scheduleOverridePayload(
  args: ScheduleOverrideArgs & { isEdit: boolean },
): ScheduleEditOverrides | ScheduleCreateOverrides {
  const { overrides, versionOverride, actor } = args;
  if (args.isEdit) {
    return {
      model_id_override: overrides.model_id_override ?? null,
      generation_config_override: overrides.generation_config_override ?? null,
      proxy_id_override: overrides.proxy_id_override ?? null,
      ...(args.versionOverrideChanged ? { version_override: versionOverride ?? null } : {}),
      connection_overrides: overrides.connection_overrides ?? null,
      ...(actor && !sameActor(actor, args.currentActor) ? { actor } : {}),
    };
  }
  return {
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
