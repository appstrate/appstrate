// SPDX-License-Identifier: Apache-2.0

import type { ModelGenerationSettings } from "@appstrate/core/model-generation";
import type { paths } from "../api/schema";
import {
  type ConnectionSet,
  withConnectionOverride,
  withDeclaredConnections,
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

/** The overrides a schedule is written with, and what a write derives the stored ones from. */
export interface ScheduleOverridesState {
  overrides: RunOverridesValue;
  /** The integrations the fired version declares; `undefined` while it loads. */
  declared: readonly string[] | undefined;
}

/**
 * What a schedule write stores: the picks, kept to the keys of `declared` (`undefined` keeps
 * every pick). The connection a fallback binds is not named here: the server names it for a
 * schedule armed by its own actor (`withScheduleFallback`), from that actor's real reach.
 */
export function savedScheduleOverrides(state: ScheduleOverridesState): RunOverridesValue {
  return withDeclaredConnections(state.overrides, state.declared);
}

export type ScheduleCreateBody =
  paths["/api/agents/{scope}/{name}/schedules"]["post"]["requestBody"]["content"]["application/json"];
export type ScheduleUpdateBody =
  paths["/api/schedules/{id}"]["patch"]["requestBody"]["content"]["application/json"];

/**
 * The body of a schedule create. Every override is omitted when empty, never `null`; no actor is
 * the caller.
 */
export function scheduleCreatePayload(
  args: ScheduleOverridesState & {
    name: string;
    cron_expression: string;
    timezone: string;
    /** What this schedule itself decides, beside the agent's own values. */
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

/**
 * A PATCH that moves who the fires run as or which version they run. Its connections are those
 * of the NEXT state, so the caller passes that state's `declared`: the stored picks (dropped by
 * an actor change: they named the previous identity's connections) kept to what the next version
 * declares.
 * `connection_overrides` is always sent, `null` when empty: an absent key on an actor change
 * would let the server reset the picks and refuse the write anyway. `version_override` is sent
 * only when it moves, `null` back to inherit.
 */
export function scheduleMovePayload(
  args: Omit<ScheduleOverridesState, "overrides"> & {
    stored: {
      actor: ActorValue;
      versionOverride: string | null;
      picks: Record<string, string[]> | null;
    };
    next: { actor?: ActorValue; versionOverride?: string | null };
  },
): ScheduleUpdateBody {
  const { stored, next } = args;
  const actorMoves = next.actor !== undefined && !sameActor(next.actor, stored.actor);
  const versionMoves =
    next.versionOverride !== undefined && next.versionOverride !== stored.versionOverride;
  const picks = actorMoves ? undefined : (stored.picks ?? undefined);
  const { connection_overrides } = savedScheduleOverrides({
    ...args,
    overrides: picks ? { connection_overrides: picks } : {},
  });
  return {
    ...(actorMoves ? { actor: next.actor } : {}),
    ...(versionMoves ? { version_override: next.versionOverride } : {}),
    connection_overrides: connection_overrides ?? null,
  };
}

/**
 * A move held until the NEXT state's facts have settled ({@link scheduleMovePayload}): `null`
 * before, since a write sent with no `declared` yet would keep every pick.
 */
export function dueScheduleMove(
  args: Parameters<typeof scheduleMovePayload>[0] & { ready: boolean },
): ScheduleUpdateBody | null {
  return args.ready ? scheduleMovePayload(args) : null;
}

/**
 * The PATCH of one connection pick: the stored picks with `integrationId`'s set replaced (`null`
 * removes it), written like every other save ({@link savedScheduleOverrides}).
 */
export function scheduleConnectionPickPayload(
  args: Omit<ScheduleOverridesState, "overrides"> & {
    picks: Record<string, string[]> | null;
    integrationId: string;
    connectionIds: ConnectionSet;
  },
): Pick<ScheduleUpdateBody, "connection_overrides"> {
  const { connection_overrides } = savedScheduleOverrides({
    ...args,
    overrides: withConnectionOverride(
      args.picks ? { connection_overrides: args.picks } : {},
      args.integrationId,
      args.connectionIds,
    ),
  });
  return { connection_overrides: connection_overrides ?? null };
}

/** The PATCH of the execution overrides: each one sent, `null` when cleared. */
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

/**
 * The answer to a write refused over connections: the same write sent again with the picks,
 * which replace the whole map it was sent with (`null` when none is picked).
 */
export function scheduleRefusalAnswerPayload<T extends ScheduleUpdateBody>(
  sent: T,
  picks: Record<string, string[]>,
): T {
  return { ...sent, connection_overrides: Object.keys(picks).length > 0 ? picks : null };
}
