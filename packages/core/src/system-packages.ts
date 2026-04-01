// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parsePackageZip } from "./zip.ts";
import { parseScopedName, buildPackageId } from "./naming.ts";
import type { PackageType } from "./validation.ts";

/** A parsed system package loaded from an AFPS file on disk. */
export interface SystemPackageEntry {
  /** Full package ID (e.g. "@system/my-flow"). */
  packageId: string;
  /** Package scope with `@` prefix. */
  scope: string;
  /** Package name without scope. */
  name: string;
  /** Package type (flow, skill, tool, provider). */
  type: PackageType;
  /** Semver version from the manifest. */
  version: string;
  /** Raw manifest object. */
  manifest: Record<string, unknown>;
  /** Original ZIP file content as a Buffer. */
  zipBuffer: Buffer;
  /** Primary content (prompt.md, SKILL.md, tool source, etc.). */
  content: string;
  /** All files extracted from the ZIP archive. */
  files: Record<string, Uint8Array>;
}

/** Result of loading system packages from a directory. */
export interface LoadSystemPackagesResult {
  /** Successfully parsed system packages. */
  packages: SystemPackageEntry[];
  /** Files that could not be parsed, with the file name and error message. */
  warnings: Array<{ file: string; error: string }>;
}

/**
 * Load all system package ZIPs from a directory.
 * Reads every `.afps` file, parses the manifest, and returns structured entries.
 * Invalid ZIPs are skipped and reported in `warnings`.
 */
export async function loadSystemPackages(dir: string): Promise<LoadSystemPackagesResult> {
  const packages: SystemPackageEntry[] = [];
  const warnings: Array<{ file: string; error: string }> = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory doesn't exist — return empty result
    return { packages, warnings };
  }

  for (const entry of entries) {
    if (!entry.endsWith(".afps") && !entry.endsWith(".zip")) continue;

    let zipBuffer: Buffer;
    try {
      zipBuffer = Buffer.from(await readFile(join(dir, entry)));
    } catch (err) {
      warnings.push({
        file: entry,
        error: `Could not read file: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    try {
      const parsed = parsePackageZip(new Uint8Array(zipBuffer));
      const manifestName = parsed.manifest.name as string | undefined;

      if (!manifestName) {
        warnings.push({ file: entry, error: "Manifest missing 'name' field" });
        continue;
      }

      const nameParts = parseScopedName(manifestName);
      if (!nameParts) {
        warnings.push({ file: entry, error: `Invalid scoped name: ${manifestName}` });
        continue;
      }

      packages.push({
        packageId: buildPackageId(nameParts.scope, nameParts.name),
        scope: `@${nameParts.scope}`,
        name: nameParts.name,
        type: parsed.type,
        version: parsed.manifest.version as string,
        manifest: parsed.manifest as unknown as Record<string, unknown>,
        zipBuffer,
        content: parsed.content,
        files: parsed.files,
      });
    } catch (err) {
      warnings.push({
        file: entry,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { packages, warnings };
}
