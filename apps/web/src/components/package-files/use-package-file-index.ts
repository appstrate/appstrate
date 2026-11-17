// SPDX-License-Identifier: Apache-2.0

import { $api } from "../../api/client";
import { useOrgScope } from "../../hooks/use-org-scope";
import { splitPackageRef } from "../../lib/package-paths";
import { generatedKeyPackage, keepPreviousWithin } from "../../lib/query-state";

/**
 * The file index of a package (`version` undefined = the draft).
 *
 * Every reader of the index goes through here so they all sit on the
 * generated `[method, path, init]` key that `invalidatePackageFiles` reaches.
 *
 * Switching version keeps the previous tree of the same package on screen
 * (`isPlaceholderData`) instead of collapsing it into a skeleton.
 */
export function usePackageFileIndex(packageId: string | undefined, version?: string) {
  const scope = useOrgScope();
  const ref = splitPackageRef(packageId ?? "");
  return $api.useQuery(
    "get",
    "/api/packages/{scope}/{name}/files",
    {
      params: {
        path: ref,
        ...(version ? { query: { version } } : {}),
        header: scope.header,
      },
    },
    {
      enabled: scope.enabled && !!packageId,
      placeholderData: keepPreviousWithin(`${ref.scope}/${ref.name}`, generatedKeyPackage),
    },
  );
}
