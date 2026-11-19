// SPDX-License-Identifier: Apache-2.0

import { packageDetailQueryOptions } from "./use-packages";
import { spaceRead, useSpaceEntry } from "./use-space-entry";
import { useCurrentOrgId } from "./use-org";

const NO_SPACES: readonly string[] = [];

/**
 * An act on an agent where `permission` holds, among `spaceIds`, the spaces the agent is active in
 * (in « Tous les espaces », none offers nothing): {@link useSpaceEntry} reading the agent's detail
 * in the space entered, so the act finds it on that space's key. `preferWorkingSpace`: a row of the
 * working space runs there without asking.
 */
export function useAgentSpaceAction(
  packageId: string,
  permission: string,
  spaceIds: readonly string[] = NO_SPACES,
  { preferWorkingSpace }: { preferWorkingSpace?: boolean } = {},
) {
  const orgId = useCurrentOrgId();
  return useSpaceEntry(
    permission,
    spaceIds,
    (spaceId) => [spaceRead(packageDetailQueryOptions("agent", { orgId, spaceId }, packageId))],
    { preferWorkingSpace },
  );
}
