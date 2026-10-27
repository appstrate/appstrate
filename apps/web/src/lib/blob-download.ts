// SPDX-License-Identifier: Apache-2.0

import { toast } from "sonner";
import i18n from "../i18n";

/**
 * `data ?? ""`: `data` is `undefined` for a zero-byte 200 (openapi-fetch short-circuits on
 * `Content-Length: 0`) and must download an empty file, not one containing "undefined".
 * `application/octet-stream`: a `blob:` URL inherits our origin and the server may echo an
 * uploader-supplied MIME (`text/html`), so pin an inert type; never pass the response's through.
 */
export function triggerBlobDownload(data: BlobPart | undefined, filename: string): void {
  const url = URL.createObjectURL(new Blob([data ?? ""], { type: "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/** Any failure, from the request or the DOM, is one `error.downloadFailed` toast. */
export async function downloadOrToast(
  read: () => Promise<{ data?: BlobPart }>,
  filename: string,
): Promise<void> {
  try {
    triggerBlobDownload((await read()).data, filename);
  } catch {
    toast.error(i18n.t("common:error.downloadFailed"));
  }
}
