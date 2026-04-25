// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers for `<ProviderCallBody>`. Lives in its own module so the
 * component file exports React components only (keeps Vite Fast Refresh
 * happy) and so log-utils can import the narrower without dragging in
 * the React tree.
 */

/** Mirrors `ProviderCallResponseBody` from `@appstrate/afps-runtime`. */
export type ProviderCallBody =
  | { kind: "text"; text: string }
  | { kind: "inline"; data: string; encoding: "base64"; mimeType: string; size: number }
  | { kind: "file"; path: string; size: number; mimeType: string; sha256: string };

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Decode a base64 payload into a Uint8Array. Uses `atob` because the
 * sizes we care about (≤ 64 KB by default) are well within main-thread
 * budget — no Buffer / WASM detour needed.
 */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Best-effort extension guess for the inline-download filename. */
export function extForMime(mime: string): string {
  const map: Record<string, string> = {
    "application/pdf": ".pdf",
    "application/json": ".json",
    "application/zip": ".zip",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "text/plain": ".txt",
    "text/html": ".html",
    "text/csv": ".csv",
  };
  return map[mime] ?? ".bin";
}

/**
 * Narrow an `unknown` payload to `ProviderCallBody`. Returns `null` if
 * the shape doesn't match the discriminated union — callers fall back
 * to whatever they were rendering before.
 */
export function asProviderCallBody(value: unknown): ProviderCallBody | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.kind === "text" && typeof v.text === "string") {
    return { kind: "text", text: v.text };
  }
  if (
    v.kind === "inline" &&
    typeof v.data === "string" &&
    v.encoding === "base64" &&
    typeof v.mimeType === "string" &&
    typeof v.size === "number"
  ) {
    return {
      kind: "inline",
      data: v.data,
      encoding: "base64",
      mimeType: v.mimeType,
      size: v.size,
    };
  }
  if (
    v.kind === "file" &&
    typeof v.path === "string" &&
    typeof v.size === "number" &&
    typeof v.mimeType === "string" &&
    typeof v.sha256 === "string"
  ) {
    return {
      kind: "file",
      path: v.path,
      size: v.size,
      mimeType: v.mimeType,
      sha256: v.sha256,
    };
  }
  return null;
}
