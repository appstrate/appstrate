// SPDX-License-Identifier: Apache-2.0

import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { $api, client } from "../../api/client";
import { useOrgScope } from "../../hooks/use-org-scope";
import { splitPackageRef } from "../../lib/package-paths";
import type { PackageFileEntry, PackageFileWriteOperation } from "../../lib/package-file-tree";

interface DraftFiles {
  /** The draft tree, or `undefined` while the index has not been read yet. */
  entries: readonly PackageFileEntry[] | undefined;
  isError: boolean;
  /**
   * Apply one atomic batch and resolve to the package row's new
   * `lock_version`. Rejects with the `ApiError` the route answered — the caller
   * decides what to say about it.
   */
  patch: (operations: PackageFileWriteOperation[]) => Promise<number>;
  isPatching: boolean;
  /** Re-read the index — the recovery from a `412`. */
  reload: () => void;
}

/**
 * The draft file tree of one package, and the single write that changes it.
 *
 * The ETag is the point of this hook. `PATCH .../files` demands `If-Match`, and
 * the only valid validator is the one that came back with the bytes this client
 * is editing — so the index cannot be served from a cache that outlived its
 * header. Hence `staleTime: 0` + `gcTime: 0`: every mount reads the tree afresh
 * rather than rendering entries whose ETag was thrown away, which would leave
 * the editor holding a tree it cannot write to. `setQueryData` after a write
 * keeps that pairing intact — the response carries both halves.
 *
 * The key is the generated openapi-react-query one, so `invalidatePackageFiles`
 * (fired by every other write that touches a draft artifact, the manifest `PUT`
 * included) reaches this query too and the ETag is refreshed with the entries.
 */
export function usePackageDraftFiles(packageId: string): DraftFiles {
  const scope = useOrgScope();
  const qc = useQueryClient();
  const params = { path: splitPackageRef(packageId), header: scope.header };
  const { queryKey } = $api.queryOptions("get", "/api/packages/{scope}/{name}/files", { params });

  // Written by the two places that receive an index representation, read by the
  // next write. A ref rather than state: it is set immediately before the value
  // that renders the tree, so nothing can observe one without the other.
  const etagRef = useRef<string | null>(null);

  const query = useQuery({
    queryKey,
    enabled: scope.enabled,
    staleTime: 0,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const { data, response } = await client.GET("/api/packages/{scope}/{name}/files", {
        params,
        signal,
      });
      etagRef.current = response.headers.get("ETag");
      return data!;
    },
  });

  const mutation = useMutation({
    mutationFn: async (operations: PackageFileWriteOperation[]) => {
      // The editor never writes blind. `If-Match: *` is the RFC 9110 "overwrite
      // whatever is there" opt-out, and it belongs to scripted callers that mean
      // it — an editor's whole claim is that its batch was composed against the
      // tree it read. The tree, hence every gesture that can produce an
      // operation, renders only once the index has landed, so a missing
      // validator is a broken invariant rather than a case to fall back from.
      const etag = etagRef.current;
      if (etag === null) {
        throw new Error("package files: a write needs the index ETag it was composed against");
      }
      const { data, response } = await client.PATCH("/api/packages/{scope}/{name}/files", {
        params: {
          path: splitPackageRef(packageId),
          header: { ...scope.header, "If-Match": etag },
        },
        body: { operations },
      });
      return { result: data!, etag: response.headers.get("ETag") };
    },
    onSuccess: ({ result, etag }) => {
      etagRef.current = etag;
      qc.setQueryData(queryKey, { entries: result.entries });
    },
  });

  return {
    entries: query.data?.entries,
    isError: query.isError,
    patch: async (operations) => (await mutation.mutateAsync(operations)).result.lock_version,
    isPatching: mutation.isPending,
    reload: () => void qc.invalidateQueries({ queryKey }),
  };
}
