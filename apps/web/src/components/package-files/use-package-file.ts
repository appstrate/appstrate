// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { $api, client } from "../../api/client";
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
  entry: PackageFileEntry,
): { text: string | undefined; isLoading: boolean; isError: boolean } {
  const scope = useOrgScope();
  // Only text files within the preview ceiling are ever fetched — a binary or
  // oversized entry renders a metadata card, never a body.
  const needsFetch = isPreviewable(entry) && entry.inline === undefined;

  // `parseAs` is not in the generated init type, but it is not an escape hatch
  // either: openapi-react-query types init as `Init & { [key: string]: unknown }`
  // and its queryFn forwards it verbatim (`fn(path, { signal, ...init })`), so
  // the option reaches openapi-fetch exactly as a direct `client.GET` would.
  // Going through `$api` is what keeps the key the generated
  // `[method, path, init]` — hand-writing that array is the drift
  // `lib/query-keys.ts` exists to warn about, and `invalidatePackageFiles`
  // prefix-matches `["get", "…/files/content"]` to reach it.
  const query = $api.useQuery(
    "get",
    "/api/packages/{scope}/{name}/files/content",
    {
      params: {
        path: splitPackageRef(packageId),
        query: { path: entry.path, version },
        header: scope.header,
      },
      parseAs: "text",
    },
    { enabled: scope.enabled && needsFetch },
  );

  // `parseAs: "text"` yields a string; the spec types the body as a Blob because
  // the route always declares `application/octet-stream`. A zero-byte file comes
  // back `null` from the empty-body branch — a successful read of an empty file,
  // which is why it is normalised here rather than left to read as "not loaded".
  const fetched = query.data as unknown as string | null | undefined;

  return {
    text: entry.inline ?? (needsFetch ? (fetched ?? undefined) : undefined),
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
  const scope = useOrgScope();
  const header = scope.header;
  return useCallback(
    async (path: string) => {
      try {
        const { data } = await client.GET("/api/packages/{scope}/{name}/files/content", {
          params: {
            path: splitPackageRef(packageId),
            query: { path, version },
            header,
          },
          parseAs: "blob",
        });
        // Re-wrapped under an INERT type. The response is already
        // `application/octet-stream`, but a `blob:` URL inherits the platform
        // origin, so the type it carries decides whether the browser would ever
        // interpret these author-controlled bytes. Never widen this.
        const url = URL.createObjectURL(new Blob([data!], { type: "application/octet-stream" }));
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
    [packageId, version, header, t],
  );
}
