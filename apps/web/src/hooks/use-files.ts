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

/**
 * List files (gallery + run tab). Org/app headers are passed explicitly so
 * they are part of the React Query key — an org/app switch refetches instead of
 * serving another scope's cached page (per the typed-client convention).
 */
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

/**
 * The gallery's files, keyset-paged (`startingAfter` = last id seen). The key keeps the
 * `[method, path]` prefix so the write invalidations reach it, and the extra segment keeps it
 * apart from `useFiles`'s plain pages; a refetch re-reads every loaded page.
 */
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

/**
 * Fetch a single file's metadata — including a freshly-minted `preview_url`
 * (its signed token is short-lived, so the preview modal refetches on each open
 * rather than reusing a token carried in a list page). The caller mounts the
 * preview only when it is open, so the fetch is scoped to that lifetime.
 */
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

/**
 * openapi-react-query keys are `[method, path, init]` with the literal spec
 * path — invalidate the list and the single-file paths separately after a
 * write (they live under different path strings), plus the org detail that
 * carries the storage total.
 */
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

/**
 * Keep ("pin") a file — clear its retention deadline so the expiry GC never
 * sweeps it. Same authorization as delete (creator or `files:delete`).
 * Invalidates the file queries on success so the pinned row reloads without
 * its expiry badge.
 */
export function useKeepFile() {
  const qc = useQueryClient();
  return $api.useMutation("post", "/api/files/{id}/keep", {
    onSuccess: () => invalidateFiles(qc),
  });
}

/**
 * Download a file's bytes. Uses the typed client with `parseAs: "blob"` so
 * the org/app scoping headers are injected by the client middleware (a bare
 * anchor navigation cannot send them) and the `307` to a presigned URL is
 * followed transparently by fetch — the same pattern as the package download.
 *
 * Handing the bytes to `downloadOrToast` (and so `triggerBlobDownload`) is what
 * keeps the inert type on this path in particular: the content route echoes the stored `row.mime`,
 * which is uploader-controlled and can be `text/html`.
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

/**
 * Copy a text file's content to the clipboard (the Artifact frame's "copy"):
 * the download's authenticated read, parsed as text, then `useCopyToClipboard`,
 * whose `copied` the caller shows. A failed read is said here; a refused
 * clipboard, there.
 */
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
 * Authenticated image preview: a stored file's bytes → an object URL for an
 * `<img src>`, revoked on unmount / id change. `undefined` while the bytes are
 * on their way, `null` when there is no preview (no grant, failed read), so a
 * caller draws a placeholder in the image's place first and its own fallback
 * only once the answer is no. Cookie auth alone is not enough — the content
 * route resolves the org/app context from the scoping headers, which the typed
 * client's middleware injects.
 *
 * THE single implementation for every image thumbnail in the app; the chat
 * module receives it through `ChatPage`'s injection seam instead of shipping
 * its own copy.
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
        // No await between this check and `createObjectURL`, so a cleanup that
        // has already run can never miss the URL it would have to revoke.
        if (cancelled) return;
        if (!data) {
          setLoaded({ id, src: null });
          return;
        }
        objectUrl = URL.createObjectURL(data);
        setLoaded({ id, src: objectUrl });
      } catch {
        // Fetch failure (403 on another member's upload, network) → no preview;
        // it is decorative.
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
