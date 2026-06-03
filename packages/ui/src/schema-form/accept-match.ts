// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests whether a file matches an HTML `accept` attribute. Mirrors the
 * MDN-documented matching rules:
 *   - `*\/*`               → any file (HTML standard accept-any wildcard)
 *   - `.ext`              → extension match (case-insensitive)
 *   - `type/*`             → MIME family match (e.g. `image/*`)
 *   - `type/subtype`       → exact MIME match
 *
 * `accept` may be a comma-separated list; the file matches if **any** entry
 * matches. Empty / whitespace-only entries are ignored.
 */
export function fileMatchesAccept(file: { name: string; type: string }, accept: string): boolean {
  const allowed = accept
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) return true;
  const ext = file.name.includes(".") ? `.${file.name.split(".").pop()!.toLowerCase()}` : "";
  const type = file.type.toLowerCase();
  return allowed.some((a) => {
    if (a === "*/*") return true;
    if (a.startsWith(".")) return a === ext;
    if (a.endsWith("/*")) return type.startsWith(a.slice(0, -1));
    return type === a;
  });
}
