// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { $api, client, type paths } from "../api/client";
import { invalidateRunDetails } from "../lib/query-keys";
import { useOrgScope } from "./use-org-scope";

/** Wire shape of a single document (OpenAPI list-item schema). */
export type DocumentDto =
  paths["/api/documents"]["get"]["responses"][200]["content"]["application/json"]["data"][number];

export interface DocumentListFilters {
  purpose?: "user_upload" | "agent_output";
  runId?: string;
  contextChatSessionId?: string;
  startingAfter?: string;
  limit?: number;
  enabled?: boolean;
}

/**
 * List documents (gallery + run tab). Org/app headers are passed explicitly so
 * they are part of the React Query key — an org/app switch refetches instead of
 * serving another scope's cached page (per the typed-client convention).
 */
export function useDocuments(filters: DocumentListFilters = {}) {
  const scope = useOrgScope();
  return $api.useQuery(
    "get",
    "/api/documents",
    {
      params: {
        query: {
          purpose: filters.purpose,
          run_id: filters.runId,
          context_chat_session_id: filters.contextChatSessionId,
          startingAfter: filters.startingAfter,
          limit: filters.limit,
        },
        header: scope.header,
      },
    },
    { enabled: scope.enabled && filters.enabled !== false },
  );
}

/**
 * Fetch a single document's metadata — including a freshly-minted `preview_url`
 * (its signed token is short-lived, so the preview modal refetches on each open
 * rather than reusing a token carried in a list page). The caller mounts the
 * preview only when it is open, so the fetch is scoped to that lifetime.
 */
export function useDocument(id: string) {
  const scope = useOrgScope();
  return $api.useQuery(
    "get",
    "/api/documents/{id}",
    { params: { path: { id }, header: scope.header } },
    { enabled: scope.enabled && !!id, staleTime: 0, gcTime: 0 },
  );
}

/**
 * Invalidate the org detail, which carries `storage.used_bytes` — the number
 * behind every storage gauge (`use-org-storage.ts`) and the "quota reached"
 * alert. Any write that changes how many bytes the org holds (delete, keep,
 * upload) MUST call this: freeing space is the only remediation path a user
 * has, and without it the gauge and the alert stay frozen on the old value.
 */
export function invalidateOrgStorage(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ["get", "/api/orgs/{orgId}"] });
}

/**
 * openapi-react-query keys are `[method, path, init]` with the literal spec
 * path — invalidate the list and the single-document paths separately after a
 * write (they live under different path strings), plus the org detail that
 * carries the storage total.
 */
function invalidateDocuments(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ["get", "/api/documents"] });
  void qc.invalidateQueries({ queryKey: ["get", "/api/documents/{id}"] });
  invalidateOrgStorage(qc);
}

export function useDeleteDocument() {
  const qc = useQueryClient();
  return $api.useMutation("delete", "/api/documents/{id}", {
    onSuccess: () => {
      invalidateDocuments(qc);
      void invalidateRunDetails(qc);
    },
  });
}

/**
 * Keep ("pin") a document — clear its retention deadline so the expiry GC never
 * sweeps it. Same authorization as delete (creator or `documents:delete`).
 * Invalidates the document queries on success so the pinned row reloads without
 * its expiry badge.
 */
export function useKeepDocument() {
  const qc = useQueryClient();
  return $api.useMutation("post", "/api/documents/{id}/keep", {
    onSuccess: () => invalidateDocuments(qc),
  });
}

/**
 * Download a document's bytes. Uses the typed client with `parseAs: "blob"` so
 * the org/app scoping headers are injected by the client middleware (a bare
 * anchor navigation cannot send them) and the `307` to a presigned URL is
 * followed transparently by fetch — the same pattern as the package download.
 */
export function useDocumentDownload() {
  const { t } = useTranslation("common");
  return useCallback(
    async (id: string, name: string) => {
      try {
        const { data } = await client.GET("/api/documents/{id}/content", {
          params: { path: { id } },
          parseAs: "blob",
        });
        const url = URL.createObjectURL(data!);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch {
        toast.error(t("error.downloadFailed"));
      }
    },
    [t],
  );
}

/**
 * Authenticated image preview: a stored document's bytes → an object URL for an
 * `<img src>`, revoked on unmount / id change. `null` while loading or on
 * failure, so callers fall back to a placeholder. Cookie auth alone is not
 * enough — the content route resolves the org/app context from the scoping
 * headers, which the typed client's middleware injects.
 *
 * THE single implementation for every image thumbnail in the app; the chat
 * module receives it through `ChatPage`'s injection seam instead of shipping
 * its own copy.
 */
export function useDocumentImageSrc(id: string): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const { data } = await client.GET("/api/documents/{id}/content", {
          params: { path: { id } },
          parseAs: "blob",
        });
        // No await between this check and `createObjectURL`, so a cleanup that
        // has already run can never miss the URL it would have to revoke.
        if (cancelled || !data) return;
        objectUrl = URL.createObjectURL(data);
        setSrc(objectUrl);
      } catch {
        // Fetch failure (403 on another member's upload, network) → stay on the
        // placeholder; this preview is decorative.
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);
  return src;
}
