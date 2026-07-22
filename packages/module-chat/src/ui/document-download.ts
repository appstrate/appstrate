// SPDX-License-Identifier: Apache-2.0

/**
 * Authenticated document download, shared by the in-chat run-progress card and
 * the sent user-message attachment chips.
 *
 * A bare `<a href>` cannot carry the `X-Org-Id` / `X-Application-Id` scoping
 * headers the content route requires, so we fetch the bytes with the forwarded
 * chat headers + cookie session (following the `307` transparently), then
 * trigger a synthetic `<a download>` click on the resulting blob. A non-2xx
 * response is swallowed (no download) rather than throwing into a click handler.
 */

import { documentContentHref } from "./run-events.ts";

export async function downloadChatDocument(
  id: string,
  name: string,
  headers: Record<string, string>,
): Promise<void> {
  const res = await fetch(documentContentHref(id), { headers, credentials: "include" });
  if (!res.ok) return;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
