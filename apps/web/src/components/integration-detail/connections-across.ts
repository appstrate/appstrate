// SPDX-License-Identifier: Apache-2.0

import type { useMyConnections } from "../../hooks/use-me-connections";
import { connectionCounter } from "../../lib/connection-count";

type MyConnectionGroups = NonNullable<ReturnType<typeof useMyConnections>["data"]>;

/**
 * The reader's own connections of `packageId` in `spaceIds`, counted as the integrations index
 * counts them (`connectionCounter`), and those of them to reauthorize, in all and by auth.
 */
export function connectionsAcross(
  groups: MyConnectionGroups,
  orgId: string | null,
  packageId: string,
  spaceIds: readonly string[],
) {
  const countWhere = (
    keep: (connection: MyConnectionGroups[number]["connections"][number]) => boolean,
  ) =>
    connectionCounter(
      groups.map((group) => ({ ...group, connections: group.connections.filter(keep) })),
      orgId,
    )(packageId, spaceIds);
  return {
    total: countWhere(() => true),
    reconnect: countWhere((connection) => connection.needs_reconnection),
    reconnectOf: (authKey: string) =>
      countWhere((connection) => connection.needs_reconnection && connection.auth_key === authKey),
  };
}
