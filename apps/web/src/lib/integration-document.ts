// SPDX-License-Identifier: Apache-2.0

/**
 * An integration's `INTEGRATION.md`, as the editor reads and writes it.
 *
 * The package's `content` column holds that optional document when the bundle
 * ships one, and a copy of the manifest text when it does not, with nothing on
 * the row saying which (see `isManifestTextFallback` in the API). The editor
 * shows the document, so it reads the fallback as "no document"; and it sends
 * the manifest text back when there is none, which is the write the API
 * refreshes the fallback from rather than one it mistakes for a document.
 */

/** The same shape test the API applies: a serialized object, not markdown. */
function isManifestText(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

/** The document an integration ships, or `""` when its column holds the manifest copy. */
export function integrationDocument(stored: string | null | undefined): string {
  return stored && !isManifestText(stored) ? stored : "";
}

/** The `content` an integration PUT carries: its document, else the manifest text. */
export function integrationWireContent(
  manifest: Record<string, unknown>,
  document: string,
): string {
  return document.trim() ? document : JSON.stringify(manifest, null, 2);
}
