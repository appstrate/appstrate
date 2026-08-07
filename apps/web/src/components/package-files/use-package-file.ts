// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { $api, client } from "../../api/client";
import { useOrgScope } from "../../hooks/use-org-scope";
import { triggerBlobDownload } from "../../lib/blob-download";
import { splitPackageRef } from "../../lib/package-paths";
import { baseName, previewBlockReason, type PackageFileEntry } from "../../lib/package-file-tree";

/**
 * The text of a finished fetch, or `undefined` when there is not one yet.
 *
 * Pure and exported because it IS the defect. openapi-fetch short-circuits on
 * `Content-Length: "0"` before `parseAs` is honoured and returns
 * `{ data: undefined }` — on a fully successful 200. So `data` alone cannot
 * tell a zero-byte file apart from a file that was never fetched, and
 * `file-preview` treats `text === undefined` as "still loading": an infinite
 * spinner on every empty file in an artifact.
 *
 * The success flag is what separates the two cases, and it has to be consulted:
 * `data` is equally `undefined` while the query is pending or disabled, so a
 * bare `data ?? ""` would render an empty editor over a request still in
 * flight — papering over a real failure instead of fixing an empty read.
 */
export function packageFileText(query: { isSuccess: boolean; data: unknown }): string | undefined {
  if (!query.isSuccess) return undefined;
  // `parseAs: "text"` yields a string; anything else here is the empty-body
  // short-circuit, which is a successful read of nothing.
  return typeof query.data === "string" ? query.data : "";
}

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
  const needsFetch = previewBlockReason(entry) === null && entry.inline === undefined;

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
  // the route always declares `application/octet-stream`. A zero-byte file never
  // reaches `parseAs` at all — the route sets `Content-Length: "0"` and
  // openapi-fetch returns `data: undefined` on the success path — so "read an
  // empty file" is read off the query state, not off `data`.
  const fetched = packageFileText(query);

  return {
    text: entry.inline ?? (needsFetch ? fetched : undefined),
    // `isPending` stays true on a disabled query — gate it on actually fetching.
    isLoading: needsFetch && query.isPending,
    isError: needsFetch && query.isError,
  };
}

/**
 * Download one file from the artifact. The route serves
 * `Content-Disposition: attachment`, but the blob still has to be handed to an
 * `<a download>` to name it — `triggerBlobDownload` is that step, shared with
 * every other download in the SPA so its empty-body (#1118) and inert-type
 * guards apply here too. A non-2xx throws in the client middleware and lands in
 * the catch below.
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
        triggerBlobDownload(data, baseName(path));
      } catch {
        toast.error(t("error.downloadFailed"));
      }
    },
    [packageId, version, header, t],
  );
}
