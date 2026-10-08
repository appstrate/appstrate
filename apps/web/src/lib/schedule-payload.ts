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

interface ScheduleOverridePayload {
  model_id_override?: string | null;
  generation_config_override?: ModelGenerationSettings | null;
  proxy_id_override?: string | null;
  version_override?: string | null;
  connection_overrides?: Record<string, string[]> | null;
  actor?: ActorValue;
}

/**
 * The override half of a schedule write. Create omits whatever is empty. Edit sends every
 * override, `null` for a cleared one (an absent key leaves the row untouched), except
 * `version_override` and the actor, sent only when they changed.
 */
export function scheduleOverridePayload(args: {
  isEdit: boolean;
  overrides: RunOverridesValue;
  versionOverride: string | undefined;
  versionOverrideChanged: boolean;
  actor: ActorValue | undefined;
  currentActor: ActorValue | undefined;
}): ScheduleOverridePayload {
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

/** The stored fields of a schedule that decide which connections its fires bind. */
interface ScheduleFireState {
  enabled: boolean;
  userId: string | null;
  endUserId: string | null;
  version_override: string | null;
  connection_overrides: Record<string, string[]> | null;
}

/** Order-insensitive identity of a connection-overrides map; `null` and `{}` are the same. */
function overridesKey(overrides: Record<string, string[]> | null | undefined): string {
  return JSON.stringify(
    Object.entries(overrides ?? {})
      .map(([id, set]) => [id, [...set].sort()] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * Whether a schedule update can change what its fires start without, so its `warnings` are news:
 * the connection picks, the actor or the frozen version moved, or the schedule was switched on.
 * A rename or a pause repeats what the last write already said. An unknown prior state counts.
 */
export function scheduleUpdateMayChangeFires(
  body: {
    enabled?: boolean;
    version_override?: string | null;
    connection_overrides?: Record<string, string[]> | null;
    actor?: ActorValue;
  },
  previous: ScheduleFireState | undefined,
): boolean {
  if (!previous) return true;
  return (
    (body.connection_overrides !== undefined &&
      overridesKey(body.connection_overrides) !== overridesKey(previous.connection_overrides)) ||
    (body.enabled === true && !previous.enabled) ||
    (body.actor !== undefined &&
      !sameActor(body.actor, {
        ...(previous.userId ? { userId: previous.userId } : {}),
        ...(previous.endUserId ? { endUserId: previous.endUserId } : {}),
      })) ||
    (body.version_override !== undefined &&
      (body.version_override ?? null) !== (previous.version_override ?? null))
  );
}
