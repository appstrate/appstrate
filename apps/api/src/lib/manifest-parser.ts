// SPDX-License-Identifier: Apache-2.0

/**
 * Parse manifest.json from a ZIP files dictionary.
 * Shared across post-install, package upload, and other ZIP-based operations.
 */

/** Parse manifest.json bytes into a validated object. Throws on missing or invalid JSON. */
export function parseManifestFromFiles(files: Record<string, Uint8Array>): Record<string, unknown> {
  const data = files["manifest.json"];
  if (!data) {
    throw new Error(
      `manifest.json not found in files dict. Available keys: ${Object.keys(files).join(", ")}`,
    );
  }
  return parseManifestBytes(data);
}

/** Parse manifest.json bytes, returning undefined on failure instead of throwing. */
export function parseManifestBytesSafe(bytes: Uint8Array): Record<string, unknown> | undefined {
  try {
    return parseManifestBytes(bytes);
  } catch {
    return undefined;
  }
}

/** Parse raw bytes as a JSON object. Throws on invalid JSON or non-object result. */
function parseManifestBytes(bytes: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder().decode(bytes);
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("manifest.json is not a valid JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error("manifest.json is not valid JSON", { cause: err });
    }
    throw err;
  }
}
