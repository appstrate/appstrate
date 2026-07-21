// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { $api, client, type paths } from "../api/client";
import { useOrgScope } from "./use-org-scope";

/** Wire shape of a single document (OpenAPI list-item schema). */
export type DocumentDto =
  paths["/api/documents"]["get"]["responses"][200]["content"]["application/json"]["data"][number];

export interface DocumentListFilters {
  purpose?: "user_upload" | "agent_output";
  runId?: string;
  packageId?: string;
  chatSessionId?: string;
  startingAfter?: string;
  limit?: number;
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
          package_id: filters.packageId,
          chat_session_id: filters.chatSessionId,
          starting_after: filters.startingAfter,
          limit: filters.limit,
        },
        header: scope.header,
      },
    },
    { enabled: scope.enabled },
  );
}

/**
 * openapi-react-query keys are `[method, path, init]` with the literal spec
 * path — invalidate the list and the single-document paths separately after a
 * write (they live under different path strings).
 */
export function invalidateDocuments(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ["get", "/api/documents"] });
  void qc.invalidateQueries({ queryKey: ["get", "/api/documents/{id}"] });
}

export function useDeleteDocument() {
  const qc = useQueryClient();
  return $api.useMutation("delete", "/api/documents/{id}", {
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
