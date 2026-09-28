// SPDX-License-Identifier: Apache-2.0

import type { ModelGenerationSettings } from "@appstrate/core/model-generation";
import type { ActorValue } from "../components/actor-select";
import type { RunOverridesValue } from "../components/run-overrides-panel";

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
 * The override half of a schedule write, built from the form's state.
 *
 * Create omits whatever is empty (the server stores null) and sends the actor
 * only when one was picked (else the caller). Edit sends every override, `null`
 * for a cleared one — an absent key would leave the row untouched — except
 * `version_override`, sent only on a real change (see the form), and the actor,
 * sent only when it differs from the schedule's. The connection picks always
 * travel as they stand: the form already dropped them when the actor changed,
 * because they belonged to the previous identity.
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
