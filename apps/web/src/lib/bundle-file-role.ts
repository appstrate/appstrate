// SPDX-License-Identifier: Apache-2.0

// A file's role in an AFPS bundle, read off its path: the file index only knows its nature
// (text, binary, image).
import { PACKAGE_CONTENT_ENTRY } from "@appstrate/core/package-files";
import type { PackageType } from "@appstrate/core/validation";

export type BundleFileRole =
  | "manifest"
  | "main"
  | "documentation"
  | "entry-point"
  | "reference"
  | "script"
  | "asset"
  | "other";

export function bundleFileRole(
  type: PackageType,
  path: string,
  manifest: Record<string, unknown>,
): BundleFileRole {
  if (path === "manifest.json") return "manifest";
  const entry = PACKAGE_CONTENT_ENTRY[type];
  if (entry && path === entry.path) return entry.required ? "main" : "documentation";
  const server = manifest.server;
  if (
    type === "mcp-server" &&
    typeof server === "object" &&
    server !== null &&
    (server as { entry_point?: unknown }).entry_point === path
  ) {
    return "entry-point";
  }
  if (path.startsWith("references/")) return "reference";
  if (path.startsWith("scripts/")) return "script";
  if (path.startsWith("assets/")) return "asset";
  return "other";
}
