// SPDX-License-Identifier: Apache-2.0

import { $api } from "../../api/client";
import { useOrgScope } from "../../hooks/use-org-scope";
import { splitPackageRef } from "../../lib/package-paths";

/**
 * The file index of a package (`version` undefined = the draft).
 *
 * Every reader of the index goes through here so they all sit on the
 * generated `[method, path, init]` key that `invalidatePackageFiles` reaches.
 */
export function usePackageFileIndex(packageId: string, version?: string) {
  const scope = useOrgScope();
  return $api.useQuery(
    "get",
    "/api/packages/{scope}/{name}/files",
    {
      params: {
        path: splitPackageRef(packageId),
        ...(version ? { query: { version } } : {}),
        header: scope.header,
      },
    },
    { enabled: scope.enabled },
  );
}
