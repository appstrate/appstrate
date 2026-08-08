// SPDX-License-Identifier: Apache-2.0

/**
 * Hand a fetched response body to the browser as a file download.
 *
 * THE single place the SPA turns bytes into a download. Every
 * `client.GET(…, { parseAs: "blob" })` call site funnels its body through here
 * so the two non-obvious guards below hold on every path instead of on
 * whichever copy happened to be written last. Callers keep their own request,
 * their own filename derivation and their own error handling — this neither
 * throws nor catches, so a failure still lands in the caller's `catch`.
 *
 * ## Guard 1 — `data ?? ""`
 *
 * `data` is `undefined` for a ZERO-BYTE body on a fully successful 200:
 * openapi-fetch short-circuits on `Content-Length: "0"` before `parseAs` is
 * ever honoured (#1118). So `undefined` here does not mean "the request
 * failed" — a non-2xx throws in the client middleware and never reaches this
 * function — it means "the read succeeded and there was nothing to read", and
 * that has to download as an empty file. Without the `?? ""`,
 * `new Blob([undefined])` stringifies its argument and writes a 9-byte file
 * containing the word "undefined", and a bare `URL.createObjectURL(data!)`
 * throws a TypeError outright.
 *
 * ## Guard 2 — `{ type: "application/octet-stream" }`
 *
 * The bytes are author-controlled and the server may echo an uploader-supplied
 * MIME (`/api/documents/{id}/content` serves the stored `row.mime`, which can
 * be `text/html`). A `blob:` URL inherits the platform origin, so the type the
 * blob carries is what decides whether the browser would ever INTERPRET those
 * bytes as markup on our origin. Re-wrapping pins an inert type at the
 * boundary the SPA owns, ahead of any sink that could navigate to the URL
 * rather than download it. It costs the caller nothing: the OS picks its
 * handler from the `download` attribute's extension, not from the blob type.
 * Never widen this, and never pass the response's own content type through.
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
