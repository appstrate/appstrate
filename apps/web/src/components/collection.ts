// SPDX-License-Identifier: Apache-2.0

/**
 * What every body of a collection has to answer, and in which order.
 *
 * A collection has more than one shape — a table, a grid of cards, a list —
 * and a caller hands any of them the same props and gets the same behaviour,
 * because the ORDER is written down once, here.
 *
 * **Failure, then loading, then emptiness.** A body that is told the request
 * failed draws the failure, whatever rows it holds. Loading comes next, because
 * "we are fetching" is a truer sentence than "there is nothing". Emptiness is
 * last: it is the only one of the three that is an ANSWER rather than a state
 * of the request.
 *
 * What counts as failed is the caller's: the run list passes `isError` only
 * when nothing was ever loaded, so a failed background refetch leaves the runs
 * already on screen in place.
 *
 * The verdict is a WORD, not a node, so that `isError` can never be swallowed:
 * a body that gets `"error"` has to draw something, and if the caller supplied
 * no message it owes a default — never "there is nothing here" on a 500.
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
