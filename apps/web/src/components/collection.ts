// SPDX-License-Identifier: Apache-2.0

/**
 * The state order every collection body (table, list) answers: failure, then
 * loading, then emptiness. A verdict is a word, not a node, so a body handed `"error"`
 * must draw something; what counts as failed is the caller's call.
 */

import type { ReactNode } from "react";

export interface CollectionState {
  isLoading?: boolean;
  /** The request failed — which is not the same thing as an empty list. */
  isError?: boolean;
  /**
   * The query's error, when there is one. Any truthy value means failed, and
   * the body draws its translated refusal unless `error` says otherwise — so a
   * caller hands `failure={error}` instead of the `isError` + `error` pair.
   */
  failure?: unknown;
  /** Shown when the collection is genuinely empty. */
  empty?: ReactNode;
  /** Shown instead when the request failed. A body must have a default. */
  error?: ReactNode;
}

/** What the body should draw. `"items"` includes drawing them while loading. */
export type CollectionVerdict = "error" | "loading" | "empty" | "items";

export function collectionVerdict(state: CollectionState, count: number): CollectionVerdict {
  if (state.isError || state.failure) return "error";
  if (state.isLoading) return "loading";
  if (count === 0 && state.empty) return "empty";
  return "items";
}
