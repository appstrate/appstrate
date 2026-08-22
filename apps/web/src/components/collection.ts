// SPDX-License-Identifier: Apache-2.0

/**
 * What every body of a collection has to answer, and in which order.
 *
 * A collection has more than one shape — a table, a grid of cards, later an
 * agenda — and a caller should be able to hand any of them the same props and
 * get the same behaviour. That only holds if the ORDER is written down once:
 * the two bodies took the same four props for a day and answered them
 * differently, the grid putting the failure first and the table letting a
 * failed refetch sit silently under stale rows.
 *
 * **Failure, then loading, then emptiness.** A request that failed is the most
 * important thing on the screen and it outranks everything, including rows
 * still in the cache — showing them is telling someone data is current when
 * nobody knows that. Loading comes next, because "we are fetching" is a truer
 * sentence than "there is nothing". Emptiness is last: it is the only one of
 * the three that is an ANSWER rather than a state of the request.
 *
 * The verdict is a WORD, not a node, so that `isError` can never be swallowed:
 * a body that gets `"error"` has to draw something, and if the caller supplied
 * no message it owes a default. The first version returned the node and read
 * `isError && error`, which quietly fell through to "there is nothing here" on
 * a 500 whenever the caller had not passed one — the very lie the empty state
 * had already had to be cured of.
 */

import type { ReactNode } from "react";

export interface CollectionState {
  isLoading?: boolean;
  /** The request failed — which is not the same thing as an empty list. */
  isError?: boolean;
  /** Shown when the collection is genuinely empty. */
  empty?: ReactNode;
  /** Shown instead when the request failed. A body must have a default. */
  error?: ReactNode;
}

/** What the body should draw. `"items"` includes drawing them while loading. */
export type CollectionVerdict = "error" | "loading" | "empty" | "items";

export function collectionVerdict(state: CollectionState, count: number): CollectionVerdict {
  if (state.isError) return "error";
  if (state.isLoading) return "loading";
  if (count === 0 && state.empty) return "empty";
  return "items";
}
