// SPDX-License-Identifier: Apache-2.0

import { useFirstRunsPage } from "./use-paginated-runs";

/**
 * The runs the team-spaces default hides (those of personal spaces): all of them, those in flight
 * and the unread ones. One read, shared by the runs page's empty state and its notice; asked only
 * while `narrowing`, and the last two only once there are any.
 */
export function useHiddenRuns(narrowing: boolean) {
  const hidden = { spanning: true, spaceKind: "personal", limit: 1 } as const;
  const total = useFirstRunsPage({ ...hidden, enabled: narrowing }).data?.total ?? 0;
  const enabled = total > 0;
  const inFlight =
    useFirstRunsPage({ ...hidden, status: ["pending", "running"], enabled }).data?.total ?? 0;
  const unread = useFirstRunsPage({ ...hidden, unread: true, enabled }).data?.total ?? 0;
  return { total, inFlight, unread };
}
