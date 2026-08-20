// SPDX-License-Identifier: Apache-2.0

/**
 * Can this model's credential still serve inference?
 *
 * `GET /api/models` LISTS a model whose credential went dead (revoked OAuth
 * refresh token, or a stored blob that no longer decrypts) instead of dropping
 * it — the row has to stay visible for the user to reconnect or delete it. So
 * every consumer has to apply the gate itself: the server picker (`llm.ts`),
 * the stored-selection reconcile and the picker rendering (`ui/`).
 *
 * `!== true` rather than truthiness: the field is optional on the wire and
 * absent on an older instance, which means live.
 *
 * Structural parameter so both row shapes pass unchanged — `OrgModel`
 * (`llm.ts`, server) and `OrgModelOption` (`ui/models-data.ts`, browser).
 * Kept in its own dependency-free leaf, like `chat-families.ts`, because
 * `llm.ts` pulls the logger and must not reach the browser
 * bundle.
 */
export function isModelLive(model: { needs_reconnection?: boolean }): boolean {
  return model.needs_reconnection !== true;
}
