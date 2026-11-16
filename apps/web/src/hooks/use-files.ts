// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { $api, client, type paths } from "../api/client";
import { keysetPaging, pagedQueryKey } from "@appstrate/ui/keyset-paging";
import { downloadOrToast } from "../lib/blob-download";
import {
  fileBlobKeys,
  invalidateOrgDetail,
  invalidatePaths,
  invalidateRunDetails,
} from "../lib/query-keys";
import { useListScope, useOrgScope } from "./use-org-scope";
import { useCurrentOrgId } from "./use-org";
import { useCurrentSpaceId } from "./use-current-space";
import { fileContextHeader, otherSpaceFileContext, type FileContext } from "../lib/file-link";
import { usePermissions } from "./use-permissions";
import { useCopyToClipboard } from "@appstrate/ui/use-copy-to-clipboard";

/** Wire shape of a single file (OpenAPI list-item schema). */
export type FileDto =
  paths["/api/files"]["get"]["responses"][200]["content"]["application/json"]["data"][number];

export interface FileListFilters {
  search?: string;
  purpose?: "user_upload" | "agent_output";
  runId?: string;
  contextChatSessionId?: string;
  limit?: number;
  enabled?: boolean;
}

/** List files (gallery + run tab); scope headers ride in the query key. */
export function useFiles(filters: FileListFilters = {}) {
  const scope = useOrgScope();
  // A run or a conversation shows its files incidentally; neither implies `files:read`.
  const { can } = usePermissions();
  return $api.useQuery(
    "get",
    "/api/files",
    {
      params: {
        query: {
          purpose: filters.purpose,
          runId: filters.runId,
          context_chat_session_id: filters.contextChatSessionId,
          q: filters.search,
          limit: filters.limit,
        },
        header: scope.header,
      },
    },
    { enabled: can("files:read") && scope.enabled && filters.enabled !== false },
  );
}

/** The gallery's (or one run's) files, keyset-paged; `spanning`, every space's the reader reaches. The `[method, path]` prefix lets write invalidations reach it; the extra segment keeps it apart from `useFiles`. */
export function useFilesPaged(
  filters: Pick<FileListFilters, "search" | "purpose" | "runId" | "limit"> & {
    spanning?: boolean;
  } = {},
) {
  const spanning = !!filters.spanning;
  const header = useOrgScope().header;
  const scope = useListScope(spanning, usePermissions().can("files:read"));
  const query = {
    purpose: filters.purpose,
    runId: filters.runId,
    q: filters.search || undefined,
    limit: filters.limit ?? 25,
  };
  return useInfiniteQuery({
    queryKey: spanning
      ? pagedQueryKey("/api/orgs/{orgId}/files", {
          params: { path: { orgId: scope.orgId }, query },
        })
      : pagedQueryKey("/api/files", { params: { header, query } }),
    queryFn: ({ pageParam, signal }) =>
      fetchFilePage(scope.acrossOrgId, { ...query, startingAfter: pageParam }, header, signal),
    ...keysetPaging,
    enabled: scope.enabled,
    // The previous result stays on screen while a new search or purpose loads.
    placeholderData: keepPreviousData,
    refetchInterval: scope.refetchInterval,
  });
}

/** One page of the current space's files, or of every space's of `acrossOrgId`. Exported for its test. */
export async function fetchFilePage(
  acrossOrgId: string | null,
  query: NonNullable<paths["/api/files"]["get"]["parameters"]["query"]>,
  header: ReturnType<typeof useOrgScope>["header"],
  signal?: AbortSignal,
) {
  const { data } = acrossOrgId
    ? await client.GET("/api/orgs/{orgId}/files", {
        params: { path: { orgId: acrossOrgId }, query },
        signal,
      })
    : await client.GET("/api/files", { params: { query, header }, signal });
  if (!data) throw new Error("empty response");
  return data;
}

/**
 * A single file's metadata with a freshly-minted `preview_url` (short-lived signed token): never
 * cached, refetched on each open. An explicit `context` (a reader link) is asked in ITS space,
 * which the server judges: the current space's grants do not gate it, and no store changes.
 */
export function useFile(id: string, context?: FileContext) {
  const scope = useOrgScope();
  const { can } = usePermissions();
  const enabled = !!id && (context !== undefined || (can("files:read") && scope.enabled));
  return $api.useQuery(
    "get",
    "/api/files/{id}",
    { params: { path: { id }, header: fileContextHeader(context) ?? scope.header } },
    { enabled, staleTime: 0, gcTime: 0 },
  );
}

/** Invalidate the list and single-file paths (different path strings) plus the org detail carrying the storage total. */
function invalidateFiles(qc: ReturnType<typeof useQueryClient>) {
  void invalidatePaths(qc, ["/api/files", "/api/orgs/{orgId}/files", "/api/files/{id}"]);
  void invalidateOrgDetail(qc);
}

export function useDeleteFile() {
  const qc = useQueryClient();
  return $api.useMutation("delete", "/api/files/{id}", {
    onSuccess: () => {
      invalidateFiles(qc);
      void invalidateRunDetails(qc);
    },
  });
}

/** Keep ("pin") a file: clears its retention deadline so the expiry GC never sweeps it. Same authorization as delete. */
export function useKeepFile() {
  const qc = useQueryClient();
  return $api.useMutation("post", "/api/files/{id}/keep", {
    onSuccess: () => invalidateFiles(qc),
  });
}

/**
 * Download a file's bytes through the typed client (a bare anchor cannot send the scoping
 * headers; fetch follows the `307` to a presigned URL). `downloadOrToast` keeps the inert type:
 * the content route echoes the uploader-controlled `row.mime`, which can be `text/html`.
 */
export function useFileDownload(context?: FileContext) {
  return useCallback(
    // `fileContext`: a row of another space, read in its own (a list spanning spaces).
    (id: string, name: string, fileContext = context) =>
      downloadOrToast(
        () =>
          client.GET("/api/files/{id}/content", {
            params: { path: { id }, header: fileContextHeader(fileContext) },
            parseAs: "blob",
          }),
        name,
      ),
    [context],
  );
}

/** Copy a text file's content to the clipboard (the Artifact frame's "copy"). A failed read is toasted here; a refused clipboard, by `useCopyToClipboard`. */
export function useFileTextCopy(context?: FileContext) {
  const { t } = useTranslation("files");
  const { copied, copy } = useCopyToClipboard();
  const copyFile = useCallback(
    async (id: string) => {
      let text: string;
      try {
        const { data } = await client.GET("/api/files/{id}/content", {
          params: { path: { id }, header: fileContextHeader(context) },
          parseAs: "text",
        });
        text = data ?? "";
      } catch {
        toast.error(t("artifact.copyFailed"));
        return;
      }
      await copy(text);
    },
    [t, copy, context],
  );
  return { copied, copy: copyFile };
}

/** Object URLs outlive a navigation: tiles and thumbnails remounting within this window reuse them. */
const FILE_BLOB_GC_TIME = 5 * 60 * 1000;

/**
 * Authenticated image preview: a stored file's bytes → an object URL for an `<img src>`, held in
 * the query cache (keyed by file id) so a remount reuses it instead of re-fetching, and revoked
 * when the entry is removed (`lib/query-client.ts`). `undefined` while loading, `null` when there
 * is no preview (no grant, failed read). THE single implementation for image thumbnails; chat
 * gets it via `ChatPage`'s injection seam.
 */
export function useFileImageSrc(id: string, spaceId?: string): string | null | undefined {
  const scope = useOrgScope();
  const orgId = useCurrentOrgId();
  const currentSpaceId = useCurrentSpaceId();
  const readsFiles = usePermissions().can("files:read");
  // A file of another space (a list spanning spaces) is read in its own, which the server judges.
  const elsewhere = otherSpaceFileContext(spaceId, orgId, currentSpaceId);
  const header = fileContextHeader(elsewhere) ?? scope.header;
  const query = useQuery({
    queryKey: fileBlobKeys.detail(id, header),
    queryFn: async ({ signal }): Promise<string | null> => {
      const { data } = await client.GET("/api/files/{id}/content", {
        params: { path: { id }, header },
        parseAs: "blob",
        signal,
      });
      // A transport can finish after cache removal, even when it ignores cancellation.
      signal.throwIfAborted();
      return data ? URL.createObjectURL(data) : null;
    },
    enabled: !!elsewhere || (readsFiles && scope.enabled),
    // Never refetched in place: a refetch would swap in a new URL without revoking the old one.
    // Only leaving the cache frees it (`lib/query-client.ts`).
    staleTime: Infinity,
    gcTime: FILE_BLOB_GC_TIME,
    retry: false,
  });
  // Decorative failures have no preview, but remain errors so reopening retries them.
  if ((!elsewhere && !readsFiles) || query.isError) return null;
  return query.data;
}
