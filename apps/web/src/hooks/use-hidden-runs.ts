// SPDX-License-Identifier: Apache-2.0

import { useFirstRunsPage } from "./use-paginated-runs";

/**
 * The runs the team-spaces default hides (those of personal spaces): all of them, those in flight
 * and the unread ones. One read, shared by the runs page's empty state and its notice; asked only
 * while `narrowing`, and the last two only once there are any.
 */
export function useHiddenRuns(narrowing: boolean) {
  const hidden = { spanning: true, spaceKind: "personal", limit: 1 } as const;
  const totalQuery = useFirstRunsPage({ ...hidden, enabled: narrowing });
  // A disabled query keeps serving its cached `data`: gate every figure on `narrowing`, not just the fetch.
  const total = narrowing ? (totalQuery.data?.total ?? 0) : 0;
  const enabled = total > 0;
  const inFlightQuery = useFirstRunsPage({ ...hidden, status: ["pending", "running"], enabled });
  const unreadQuery = useFirstRunsPage({ ...hidden, unread: true, enabled });
  return {
    total,
    inFlight: enabled ? (inFlightQuery.data?.total ?? 0) : 0,
    unread: enabled ? (unreadQuery.data?.total ?? 0) : 0,
  };
}
