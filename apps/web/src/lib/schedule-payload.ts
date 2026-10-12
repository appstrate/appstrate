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

/** The overrides a schedule is written with, and what a write derives the stored ones from. */
interface ScheduleOverridesState {
  overrides: RunOverridesValue;
  runsAsViewer: boolean;
  /** The viewer's readiness entries for the fired version. */
  viewerReadiness: readonly FallbackBindingEntry[] | undefined;
  /** The integrations the fired version declares; `undefined` while it loads. */
  declared: readonly string[] | undefined;
}

/**
 * What a schedule write stores. For a schedule running as the viewer, the connection the
 * fallback binds is named from `viewerReadiness` (the server takes no fallback for a schedule);
 * for any other actor that verdict speaks for nobody and names nothing. Then only the keys of
 * `declared` are kept; `undefined` keeps every pick.
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
