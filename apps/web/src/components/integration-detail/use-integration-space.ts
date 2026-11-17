// SPDX-License-Identifier: Apache-2.0

import { $api } from "../../api/client";
import { useCurrentOrgId } from "../../hooks/use-org";
import { packageDetailQueryOptions } from "../../hooks/use-packages";
import { usePermissions } from "../../hooks/use-permissions";
import { useSpacesFor } from "../../hooks/use-space-action";
import { spaceRead, useSpaceEntry } from "../../hooks/use-space-entry";

/**
 * The space an integration's per-space tab is shown from, in « Tous les espaces »: one of
 * `spaceIds` (where it is active) granting `permission`, picked by the reader. Entering it reads
 * the integration and its package detail there first (`useSpaceEntry`).
 */
export function useIntegrationSpaceAction(
  packageId: string,
  permission: string,
  spaceIds: readonly string[],
) {
  const orgId = useCurrentOrgId();
  return useSpaceEntry(
    permission,
    spaceIds,
    (spaceId) => [
      spaceRead(
        $api.queryOptions("get", "/api/integrations/{packageId}", {
          params: {
            path: { packageId },
            header: { "X-Org-Id": orgId ?? undefined, "X-Space-Id": spaceId },
          },
        }),
      ),
      spaceRead(packageDetailQueryOptions("integration", { orgId, spaceId }, packageId)),
    ],
    { preferWorkingSpace: false },
  );
}

/**
 * Whether the integration's configuration opens: the working space's grant with a space selected;
 * in « Tous les espaces », some space of `spaceIds` (where it is active) granting it.
 */
export function useConfiguresIntegration(spaceIds: readonly string[]): boolean {
  const { can } = usePermissions();
  const { on, offered } = useSpacesFor({ permission: "integrations:configure" }, spaceIds);
  return on ? offered : can("integrations:configure");
}
