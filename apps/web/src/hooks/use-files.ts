// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { keepPreviousData, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { $api, client, type paths } from "../api/client";
import { keysetPaging } from "../lib/keyset-paging";
import { downloadOrToast } from "../lib/blob-download";
import { invalidateOrgDetail, invalidatePaths, invalidateRunDetails } from "../lib/query-keys";
import { useOrgScope } from "./use-org-scope";
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

/** The gallery's files, keyset-paged. The `[method, path]` prefix lets write invalidations reach it; the extra segment keeps it apart from `useFiles`. */
export function useFilesPaged(filters: Pick<FileListFilters, "search" | "purpose"> = {}) {
  const scope = useOrgScope();
  const { can } = usePermissions();
  const query = { purpose: filters.purpose, q: filters.search || undefined, limit: 25 };
  return useInfiniteQuery({
    queryKey: ["get", "/api/files", "paged", { header: scope.header, query }] as const,
    queryFn: async ({ pageParam, signal }) => {
      const { data } = await client.GET("/api/files", {
        params: { query: { ...query, startingAfter: pageParam }, header: scope.header },
        signal,
      });
      if (!data) throw new Error("empty response");
      return data;
    },
    ...keysetPaging,
    enabled: can("files:read") && scope.enabled,
    // The previous result stays on screen while a new search or purpose loads.
    placeholderData: keepPreviousData,
  });
}

/** A single file's metadata with a freshly-minted `preview_url` (short-lived signed token): never cached, refetched on each open. */
export function useFile(id: string) {
  const scope = useOrgScope();
  const { can } = usePermissions();
  return $api.useQuery(
    "get",
    "/api/files/{id}",
    { params: { path: { id }, header: scope.header } },
    { enabled: can("files:read") && scope.enabled && !!id, staleTime: 0, gcTime: 0 },
  );
}

/** Invalidate the list and single-file paths (different path strings) plus the org detail carrying the storage total. */
function invalidateFiles(qc: ReturnType<typeof useQueryClient>) {
  void invalidatePaths(qc, ["/api/files", "/api/files/{id}"]);
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
export function useFileDownload() {
  return useCallback(
    (id: string, name: string) =>
      downloadOrToast(
        () => client.GET("/api/files/{id}/content", { params: { path: { id } }, parseAs: "blob" }),
        name,
      ),
    [],
  );
}

/** Copy a text file's content to the clipboard (the Artifact frame's "copy"). A failed read is toasted here; a refused clipboard, by `useCopyToClipboard`. */
export function useFileTextCopy() {
  const { t } = useTranslation("files");
  const { copied, copy } = useCopyToClipboard();
  const copyFile = useCallback(
    async (id: string) => {
      let text: string;
      try {
        const { data } = await client.GET("/api/files/{id}/content", {
          params: { path: { id } },
          parseAs: "text",
        });
        text = data ?? "";
      } catch {
        toast.error(t("artifact.copyFailed"));
        return;
      }
      await copy(text);
    },
    [t, copy],
  );
  return { copied, copy: copyFile };
}

/**
 * Authenticated image preview: a stored file's bytes → an object URL for an `<img src>`, revoked
 * on unmount / id change. `undefined` while loading, `null` when there is no preview (no grant,
 * failed read). THE single implementation for image thumbnails; chat gets it via `ChatPage`'s injection seam.
 */
export function useFileImageSrc(id: string): string | null | undefined {
  const [loaded, setLoaded] = useState<{ id: string; src: string | null } | null>(null);
  const readsFiles = usePermissions().can("files:read");
  useEffect(() => {
    if (!readsFiles) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const { data } = await client.GET("/api/files/{id}/content", {
          params: { path: { id } },
          parseAs: "blob",
        });
        // No await between this check and `createObjectURL`: cleanup can never miss the URL to revoke.
        if (cancelled) return;
        if (!data) {
          setLoaded({ id, src: null });
          return;
        }
        objectUrl = URL.createObjectURL(data);
        setLoaded({ id, src: objectUrl });
      } catch {
        // Decorative: a failed fetch (403, network) means no preview.
        if (!cancelled) setLoaded({ id, src: null });
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, readsFiles]);
  if (!readsFiles) return null;
  return loaded?.id === id ? loaded.src : undefined;
}
