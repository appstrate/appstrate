// SPDX-License-Identifier: Apache-2.0

import { useQueries } from "@tanstack/react-query";
import { $api } from "../../api/client";
import { useOrgScope } from "../../hooks/use-org-scope";
import { splitPackageRef } from "../../lib/package-paths";

const FILES_PATH = "/api/packages/{scope}/{name}/files";

/**
 * The file index of a package (`version` undefined = the draft).
 *
 * Every reader of the index goes through here so they all sit on the
 * generated `[method, path, init]` key that `invalidatePackageFiles` reaches.
 * `fresh` is for an authoring surface: it must not seed from a cached index.
 */
export function usePackageFileIndex(
  packageId: string | undefined,
  version?: string,
  fresh = false,
) {
  const scope = useOrgScope();
  return $api.useQuery(
    "get",
    FILES_PATH,
    {
      params: {
        path: splitPackageRef(packageId ?? ""),
        ...(version ? { query: { version } } : {}),
        header: scope.header,
      },
    },
    {
      enabled: scope.enabled && !!packageId,
      ...(fresh ? { staleTime: 0, gcTime: 0, refetchOnMount: "always" as const } : {}),
    },
  );
}

/**
 * The draft file index of several packages at once, in the order of `packageIds`.
 * An `undefined` id is skipped (its query stays disabled), so a caller can fetch
 * only the packages it has a reason to read.
 */
export function usePackageFileIndexes(packageIds: readonly (string | undefined)[]) {
  const scope = useOrgScope();
  return useQueries({
    queries: packageIds.map((packageId) => ({
      ...$api.queryOptions("get", FILES_PATH, {
        params: { path: splitPackageRef(packageId ?? ""), header: scope.header },
      }),
      enabled: scope.enabled && !!packageId,
    })),
  });
}
