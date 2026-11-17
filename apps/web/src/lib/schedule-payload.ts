// SPDX-License-Identifier: Apache-2.0

import type { ModelGenerationSettings } from "@appstrate/core/model-generation";
import type { paths } from "../api/schema";
import { withDeclaredConnections } from "./connection-set";

/** An execution identity, the platform `actor` wire shape: exactly one field set (user XOR end-user). */
export type ActorValue = { userId?: string; endUserId?: string };

export interface RunOverridesValue {
  model_id_override?: string;
  generation_config_override?: ModelGenerationSettings;
  proxy_id_override?: string;
  /**
   * Per-integration connection sets (the launch-override layer), replayed on every
   * schedule fire. Beats member pins and the soft default. Under an admin pin or an
   * enforced org default the imposed set always binds and an override only adds to it
   * (`[]` adds nothing): where the lock is closed to additions, naming a connection
   * outside it is `override_outranked`.
   */
  connection_overrides?: Record<string, string[]>;
}

export function sameActor(a: ActorValue | undefined, b: ActorValue | undefined): boolean {
  return (
    (a?.userId ?? null) === (b?.userId ?? null) && (a?.endUserId ?? null) === (b?.endUserId ?? null)
  );
}

export interface ScheduleOverridesState {
  overrides: RunOverridesValue;
  /** The integrations the fired version declares; `undefined` while it loads. */
  declared: readonly string[] | undefined;
}

/**
 * What a schedule write stores: the picks, kept to the keys of `declared` (`undefined`
 * keeps every pick). A fallback's connection is named by the server (`withScheduleFallback`).
 */
export function savedScheduleOverrides(state: ScheduleOverridesState): RunOverridesValue {
  return withDeclaredConnections(state.overrides, state.declared);
}

export type ScheduleCreateBody =
  paths["/api/agents/{scope}/{name}/schedules"]["post"]["requestBody"]["content"]["application/json"];
export type ScheduleUpdateBody =
  paths["/api/schedules/{id}"]["patch"]["requestBody"]["content"]["application/json"];

/** The body of a schedule create. Every override is omitted when empty, never `null`; no actor is the caller. */
export function scheduleCreatePayload(
  args: ScheduleOverridesState & {
    name: string;
    cron_expression: string;
    timezone: string;
    input: Record<string, unknown>;
    versionOverride: string | undefined;
    actor: ActorValue | undefined;
  },
): ScheduleCreateBody {
  const overrides = savedScheduleOverrides(args);
  const name = args.name.trim();
  return {
    ...(name ? { name } : {}),
    cron_expression: args.cron_expression,
    timezone: args.timezone,
    input: args.input,
    ...(overrides.model_id_override ? { model_id_override: overrides.model_id_override } : {}),
    ...(overrides.generation_config_override
      ? { generation_config_override: overrides.generation_config_override }
      : {}),
    ...(overrides.proxy_id_override ? { proxy_id_override: overrides.proxy_id_override } : {}),
    ...(args.versionOverride ? { version_override: args.versionOverride } : {}),
    ...(overrides.connection_overrides
      ? { connection_overrides: overrides.connection_overrides }
      : {}),
    ...(args.actor ? { actor: args.actor } : {}),
  };
}

/** What the reader changed on a schedule's settings since it was stored; an absent key is untouched. */
export interface ScheduleDraft {
  name?: string;
  cron?: string;
  timezone?: string;
  actor?: ActorValue;
  /** `null` inherits the latest published version. */
  versionOverride?: string | null;
  /** The body of `input`: only what differs from the agent's values. */
  input?: Record<string, unknown>;
  overrides?: RunOverridesValue;
  /** The connection picks, whole. */
  picks?: Record<string, string[]>;
}

/**
 * The one PATCH a settings save sends: the changed keys only (an absent key is left as stored).
 * Connections are those of the NEXT state (`declared` is its fired version's): a move of the actor
 * or the version, or a pick, sends `connection_overrides` (`null` when empty), and an actor move
 * drops the stored picks, which named the previous identity's connections.
 */
export function scheduleUpdatePayload(args: {
  stored: {
    actor: ActorValue;
    versionOverride: string | null;
    picks: Record<string, string[]> | null;
  };
  draft: ScheduleDraft;
  declared: readonly string[] | undefined;
}): ScheduleUpdateBody {
  const { stored, draft } = args;
  const name = draft.name?.trim();
  const actorMoves = draft.actor !== undefined && !sameActor(draft.actor, stored.actor);
  const versionMoves =
    draft.versionOverride !== undefined && draft.versionOverride !== stored.versionOverride;
  const picks = draft.picks ?? (actorMoves ? undefined : (stored.picks ?? undefined));
  const { connection_overrides } = savedScheduleOverrides({
    declared: args.declared,
    overrides: picks ? { connection_overrides: picks } : {},
  });
  return {
    ...(name ? { name } : {}),
    ...(draft.cron ? { cron_expression: draft.cron } : {}),
    ...(draft.timezone ? { timezone: draft.timezone } : {}),
    ...(actorMoves ? { actor: draft.actor } : {}),
    ...(versionMoves ? { version_override: draft.versionOverride } : {}),
    ...(draft.input ? { input: draft.input } : {}),
    ...(draft.overrides ? scheduleExecutionPayload(draft.overrides) : {}),
    ...(actorMoves || versionMoves || draft.picks
      ? { connection_overrides: connection_overrides ?? null }
      : {}),
  };
}

export function scheduleExecutionPayload(
  overrides: RunOverridesValue,
): Pick<
  ScheduleUpdateBody,
  "model_id_override" | "generation_config_override" | "proxy_id_override"
> {
  return {
    model_id_override: overrides.model_id_override ?? null,
    generation_config_override: overrides.generation_config_override ?? null,
    proxy_id_override: overrides.proxy_id_override ?? null,
  };
}
