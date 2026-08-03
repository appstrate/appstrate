// SPDX-License-Identifier: Apache-2.0

import type { OrgModelInfo } from "../hooks/use-models";

/**
 * Can this model be picked for a run or a chat?
 *
 * Two independent ways a LISTED model is unusable, and every selection surface
 * must honour both — they are exactly the two `loadModel()` returns null for:
 *
 *  - `enabled: false` — the row is switched off.
 *  - `needs_reconnection` — its stored credential can no longer serve
 *    inference (an OAuth credential flagged for reconnection, or, for either
 *    auth mode, a secret that no longer decrypts).
 *
 * Such a model is listed on purpose: it used to be dropped from
 * `GET /api/models`, which made it invisible, hence impossible to detach,
 * which pinned its credential behind a permanent 409 `credential_in_use`.
 * The read surface now shows it so it can be inspected and deleted — so
 * "renderable" is deliberately NOT this predicate. Listing surfaces (the
 * settings table, the onboarding recap) show everything and mark the state;
 * only the *choice* is gated here.
 */
export function isModelSelectable(model: OrgModelInfo): boolean {
  return model.enabled && !model.needs_reconnection;
}
