// SPDX-License-Identifier: Apache-2.0

/**
 * What the authoring loop needs to know about a package that is not a skill:
 * which route family serves it, which file it is authored around, and where it
 * is installed so the file routes answer. Agents, integrations and MCP servers
 * are packages like skills — same draft, same versions, same import — only the
 * detail/versions routes are per type.
 */

import { encodePackageIdPath, parseScopedName } from "@appstrate/core/naming";
import { apiFetch, ApiError } from "./api.ts";
import type { Profile } from "./config.ts";

export type PackageType = "skill" | "agent" | "integration" | "mcp-server";

export const PACKAGE_TYPES: readonly PackageType[] = [
  "skill",
  "agent",
  "integration",
  "mcp-server",
];

/** Route segment and work-dir folder for each type. */
export const TYPE_PLURAL: Record<PackageType, string> = {
  skill: "skills",
  agent: "agents",
  integration: "integrations",
  "mcp-server": "mcp-servers",
};

/** The file a package of that type is authored around, when it has one. */
export const CONTENT_ENTRY: Record<PackageType, string | null> = {
  skill: "SKILL.md",
  agent: "prompt.md",
  integration: null,
  "mcp-server": null,
};

export function isPackageType(value: unknown): value is PackageType {
  return typeof value === "string" && (PACKAGE_TYPES as readonly string[]).includes(value);
}

/** `/api/packages/<plural>/@scope/name`, the per-type detail and versions root. */
export function packagePath(type: PackageType, packageId: string): string {
  return `/api/packages/${TYPE_PLURAL[type]}/${encodePackageIdPath(packageId)}`;
}

export interface LocatedPackage {
  packageId: string;
  type: PackageType;
  /** A space the package is installed in, the pinned one when it is; undefined when installed nowhere. */
  spaceId: string | undefined;
  installedIn: string[];
}

interface LibraryRow {
  id?: unknown;
  type?: unknown;
  installed_in?: unknown;
}

/**
 * Find a package of any type in the organization's catalogue. `/api/library`
 * lists every package the org owns, with the spaces it is installed in; the
 * per-type list routes only show what is installed in the current space.
 */
export async function locatePackage(
  profileName: string,
  profile: Profile,
  packageId: string,
): Promise<LocatedPackage | null> {
  if (!parseScopedName(packageId)) throw new Error(`Not a package id: ${packageId}`);
  let library: { packages?: Record<string, LibraryRow[]> };
  try {
    library = await apiFetch<{ packages?: Record<string, LibraryRow[]> }>(
      profileName,
      "/api/library",
    );
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
    // No library on this instance: ask each type's detail route in turn, in
    // the pinned space, which is the only one such an instance can answer for.
    for (const type of PACKAGE_TYPES) {
      try {
        await apiFetch<unknown>(profileName, packagePath(type, packageId));
        return {
          packageId,
          type,
          spaceId: profile.spaceId,
          installedIn: profile.spaceId ? [profile.spaceId] : [],
        };
      } catch (probe) {
        if (!(probe instanceof ApiError && probe.status === 404)) throw probe;
      }
    }
    return null;
  }
  for (const [type, rows] of Object.entries(library.packages ?? {})) {
    if (!isPackageType(type)) continue;
    const row = rows.find((r) => r.id === packageId);
    if (!row) continue;
    const installedIn = Array.isArray(row.installed_in)
      ? row.installed_in.filter((s): s is string => typeof s === "string")
      : [];
    const pinned =
      profile.spaceId && installedIn.includes(profile.spaceId) ? profile.spaceId : undefined;
    return { packageId, type, spaceId: pinned ?? installedIn[0], installedIn };
  }
  return null;
}

/** Type from a folder's files: the manifest's `type`, else a skill when it has a SKILL.md. */
export function typeOfFolder(files: Record<string, Uint8Array>): PackageType | null {
  const manifest = files["manifest.json"];
  if (manifest) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(manifest)) as { type?: unknown };
      if (isPackageType(parsed.type)) return parsed.type;
    } catch {
      // Reported by the manifest validation downstream.
    }
  }
  return files["SKILL.md"] ? "skill" : null;
}
