// SPDX-License-Identifier: Apache-2.0

/**
 * Can this model be picked for a run or a chat?
 *
 * Two independent ways a LISTED model is unusable, and every selection surface
 * must honour both:
 *
 *  - `enabled: false` — the row is switched off.
 *  - `needs_reconnection` — its stored credential can no longer serve
 *    inference (an OAuth credential flagged for reconnection, or, for either
 *    auth mode, a secret that no longer decrypts).
 *
 * `GET /api/models` lists such a model on purpose, so it can be inspected,
 * reconnected or deleted; listing surfaces show everything and mark the state,
 * only the *choice* is gated here. Both fields are optional on the wire — an
 * absent one means usable.
 */
export function isModelSelectable(model: {
  enabled?: boolean;
  needs_reconnection?: boolean;
}): boolean {
  return model.enabled !== false && model.needs_reconnection !== true;
}
