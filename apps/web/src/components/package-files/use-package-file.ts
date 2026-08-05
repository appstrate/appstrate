// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { client } from "../../api/client";
import { useOrgScope } from "../../hooks/use-org-scope";
import { splitPackageRef } from "../../lib/package-paths";
import { baseName, isPreviewable, type PackageFileEntry } from "../../lib/package-file-tree";

/**
 * Text of one package file, wherever it came from.
 *
 * The index carries `inline` for text files that fit the response's cumulative
 * budget; everything else has to be fetched. Callers must not have to care
 * which happened, so this hook hides the difference behind a single `text`.
 *
 * Takes the whole entry rather than a bare path: `inline` and the previewable
 * verdict both live on it, and re-deriving them from a path would mean handing
 * the hook the entire index as well.
 */
export function usePackageFile(
  packageId: string,
  version: string | undefined,
  entry: PackageFileEntry | null,
): { text: string | undefined; isLoading: boolean; isError: boolean } {
  const scope = useOrgScope();
  // Only text files within the preview ceiling are ever fetched — a binary or
  // oversized entry renders a metadata card, never a body.
  const needsFetch = !!entry && isPreviewable(entry) && entry.inline === undefined;

  const init = {
    params: {
      path: splitPackageRef(packageId),
      query: { path: entry?.path ?? "", version },
      header: scope.header,
    },
  };

  // openapi-react-query cannot express `parseAs: "text"` (the spec types the
  // body as a Blob, since the route always serves octet-stream), so the fetch
  // goes through the raw typed client inside a plain query. The key keeps the
  // client's `[method, path, init]` shape so it lives alongside the generated
  // ones and picks up org/app scope.
  const query = useQuery({
    queryKey: ["get", "/api/packages/{scope}/{name}/files/content", init],
    queryFn: async () => {
      const { data } = await client.GET("/api/packages/{scope}/{name}/files/content", {
        ...init,
        parseAs: "text",
      });
      // `parseAs: "text"` yields a string; the spec types the body as a Blob
      // because the route always declares `application/octet-stream`.
      return data as unknown as string;
    },
    enabled: scope.enabled && needsFetch,
  });

  return {
    text: entry?.inline ?? (needsFetch ? query.data : undefined),
    // `isPending` stays true on a disabled query — gate it on actually fetching.
    isLoading: needsFetch && query.isPending,
    isError: needsFetch && query.isError,
  };
}

/**
 * Download one file from the artifact. Same object-URL approach as
 * `usePackageDownload` — the route serves `Content-Disposition: attachment`,
 * but the blob still has to be handed to an `<a download>` to name it.
 */
export function usePackageFileDownload(packageId: string, version: string | undefined) {
  const { t } = useTranslation("common");
  return useCallback(
    async (path: string) => {
      try {
        const { data } = await client.GET("/api/packages/{scope}/{name}/files/content", {
          params: {
            path: splitPackageRef(packageId),
            query: { path, version },
          },
          parseAs: "blob",
        });
        const url = URL.createObjectURL(data!);
        const a = document.createElement("a");
        a.href = url;
        a.download = baseName(path);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch {
        toast.error(t("error.downloadFailed"));
      }
    },
    [packageId, version, t],
  );
}
