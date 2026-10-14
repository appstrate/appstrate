// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import type { CollectionState, CollectionVerdict } from "./collection";
import { ErrorState } from "./page-states";

/**
 * The table's frame, worn by the states of a body whose items sit loose on the
 * canvas: an empty grid or list then occupies the place its items would have.
 */
function CollectionFrame({ children }: { children: ReactNode }) {
  return <div className="bg-card overflow-hidden rounded-lg border shadow-sm">{children}</div>;
}

/** Every verdict but `"items"`, for a card grid or an item list. */
export function CollectionStates({
  verdict,
  state,
  skeleton,
}: {
  verdict: Exclude<CollectionVerdict, "items">;
  state: CollectionState;
  skeleton: ReactNode;
}) {
  // A failure (`isError` or `failure`) always draws something, written by the caller or not.
  if (verdict === "error") {
    return (
      <CollectionFrame>
        {state.error ?? <ErrorState error={state.failure} compact />}
      </CollectionFrame>
    );
  }
  if (verdict === "loading") return skeleton;
  return <CollectionFrame>{state.empty}</CollectionFrame>;
}
