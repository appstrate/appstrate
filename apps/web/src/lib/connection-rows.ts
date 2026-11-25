// SPDX-License-Identifier: Apache-2.0

import type { IntegrationConnection, IntegrationDetailIn } from "../hooks/use-integrations";
import { rowSpace } from "./across-spaces";

/**
 * One connection of an integration's list, as the space it acts in reads it. A connection shared
 * into several spaces is one row: `rowSpaceIds` names every space listing it, and its fields
 * relative to a space (`shared_here`, `locked_by`, `allowed_actions`) are those of `rowSpaceId`,
 * the current space when it is one of them (`rowSpace`), where its row controls act.
 */
export type ConnectionRow = IntegrationConnection & {
  rowSpaceId: string;
  rowSpaceIds: string[];
};

/** The rows of `sources`, one per connection, in the order they first appear. */
export function connectionRows(
  sources: readonly IntegrationDetailIn[],
  currentSpaceId: string | null,
): ConnectionRow[] {
  const bySpaceOf = new Map<string, Map<string, IntegrationConnection>>();
  for (const { spaceId, detail } of sources) {
    for (const auth of detail.auths) {
      for (const connection of auth.connections) {
        const bySpace = bySpaceOf.get(connection.id) ?? new Map<string, IntegrationConnection>();
        bySpace.set(spaceId, { ...connection, auth_key: auth.auth_key });
        bySpaceOf.set(connection.id, bySpace);
      }
    }
  }
  return [...bySpaceOf.values()].map((bySpace) => {
    const rowSpaceIds = [...bySpace.keys()];
    const rowSpaceId = rowSpace(rowSpaceIds, currentSpaceId)!;
    return { ...bySpace.get(rowSpaceId)!, rowSpaceId, rowSpaceIds };
  });
}
