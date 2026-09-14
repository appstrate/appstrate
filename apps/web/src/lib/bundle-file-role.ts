// SPDX-License-Identifier: Apache-2.0

/**
 * What a file IS in an AFPS bundle, read off its path.
 *
 * The file index only knows a file's nature (text, binary, image). Its role in
 * the package comes from the spec and the conventions the bundle follows: the
 * manifest, the type's main file, an integration's optional document, a local
 * server's entry point, and the Agent Skills folders (references/, scripts/,
 * assets/). Anything else is the author's own.
 */
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
