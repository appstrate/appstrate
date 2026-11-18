// SPDX-License-Identifier: Apache-2.0

import { spaceHeader } from "./scoping-headers";

/** A request's scope: a space named, or none (the client's middleware scopes it to the working space). */
export type SpaceScopedInit = ReturnType<typeof spaceHeader>;

/**
 * « Tout marquer comme lu » over a list (the runs, the bell): the route marks one space, so `put`
 * once per space the list spans, each naming it; `null` is the working space's list, one request
 * naming none. Every request settles before the outcome: one refusal fails it once, with the
 * first refusal, after the others have landed.
 */
export async function markAllReadIn(
  spaceIds: readonly string[] | null,
  put: (init: SpaceScopedInit) => Promise<unknown>,
): Promise<void> {
  const inits = spaceIds === null ? [{}] : spaceIds.map((spaceId) => spaceHeader(spaceId));
  const outcomes = await Promise.allSettled(inits.map(put));
  const refused = outcomes.find((outcome) => outcome.status === "rejected");
  if (refused) throw refused.reason;
}
