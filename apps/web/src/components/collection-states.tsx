// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import type { CollectionState, CollectionVerdict } from "./collection";
import { ErrorState } from "./page-states";

/**
 * Every verdict but `"items"`, for a card grid or an item list: an empty or failed body wears
 * the table's frame, so it occupies the place its items would have.
 */
export function CollectionStates({
  verdict,
  state,
  skeleton,
}: {
  verdict: Exclude<CollectionVerdict, "items">;
  state: CollectionState;
  skeleton: ReactNode;
}) {
  if (verdict === "loading") return skeleton;
  return (
    <div className="bg-card overflow-hidden rounded-lg border">
      {/* A failure always draws something, written by the caller or not. */}
      {verdict === "error"
        ? (state.error ?? <ErrorState error={state.failure} compact />)
        : state.empty}
    </div>
  );
}
