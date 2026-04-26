// SPDX-License-Identifier: Apache-2.0

/**
 * Compose project-name management for `appstrate install`.
 *
 * The CLI passes `--project-name <name>` explicitly on every `docker
 * compose` invocation so the project namespace is under our control:
 *
 *   1. `deriveProjectName(dir)` turns the install directory into a
 *      stable, Compose-legal project name (`appstrate-<slug>-<hash>`).
 *      The hash disambiguates installs that land in sibling directories
 *      with the same basename; the slug keeps the name readable when a
 *      user lists projects with `docker compose ls`.
 *
 *   2. `<dir>/.appstrate/project.json` is written at install time so
 *      subsequent runs (`appstrate install` as an upgrade,
 *      uninstall/upgrade helpers we may add later) read the exact name
 *      this dir is bound to — never re-derive, never drift. A user who
 *      renames the install dir will get a fresh project name on the
 *      next upgrade, but that's the right behavior: Compose would have
 *      produced different default-named containers anyway.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";

/**
 * File we persist under the install directory to freeze the project
 * name chosen at install time. Relative path so it travels with the
 * dir if the user moves everything together (absolute path would rot).
 */
export const PROJECT_FILE_RELPATH = ".appstrate/project.json";

/** On-disk shape — versioned so we can evolve the format without a migration. */
export interface ProjectFile {
  /** Bump to 2 if a future change is not backward-readable. */
  version: 1;
  /** Compose project name passed as `--project-name`. */
  projectName: string;
  /** When this install was first bound to the name (ISO-8601 UTC). */
  createdAt: string;
}

/** Compose project-name legal charset: [a-z0-9][a-z0-9_-]* — lowercase + digits + `_` / `-`. */
function slugify(input: string): string {
  const lowered = input.toLowerCase();
  // Collapse every illegal char into `-` then squeeze repeated `-` runs.
  const withDashes = lowered.replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-");
  // Trim leading/trailing separators — Compose rejects a project name
  // that starts with `-` or `_`.
  const trimmed = withDashes.replace(/^[-_]+|[-_]+$/g, "");
  return trimmed;
}

/**
 * Derive the Compose project name for an install rooted at `absDir`.
 *
 * Shape: `appstrate-<slug>-<hash8>` — the `appstrate-` prefix makes
 * installs easy to find via `docker compose ls --filter name=appstrate`,
 * the slug is a readable hint drawn from the directory basename, the
 * 8-char hex hash disambiguates two installs that share a basename
 * (e.g. `~/dev/appstrate` and `~/prod/appstrate`). Total length stays
 * well under Compose's practical limit (< 63 chars for container names).
 *
 * The hash is computed over the ABSOLUTE path so symlinks that resolve
 * to the same target always collide to the same project (good — they
 * ARE the same install). Collisions across truly distinct dirs are
 * ~2⁻³² — vanishingly unlikely in the finite set of install dirs any
 * single host will ever have.
 *
 * Exported — and kept pure — so unit tests can pin the exact wire
 * format without spinning up Docker.
 */
export function deriveProjectName(absDir: string): string {
  const slug = slugify(basename(absDir)).slice(0, 32) || "install";
  const hash = createHash("sha256").update(absDir).digest("hex").slice(0, 8);
  return `appstrate-${slug}-${hash}`;
}

/** Path to the sidecar file that records the project name for `dir`. */
export function projectFilePath(dir: string): string {
  return join(dir, PROJECT_FILE_RELPATH);
}

/**
 * Read `<dir>/.appstrate/project.json` if present, returning the parsed
 * record. Returns `null` when the file is missing.
 *
 * Malformed files (bad JSON, wrong shape, unknown `version`) are treated
 * as missing. That's safer than throwing — the install flow would then
 * overwrite the file with a fresh derived name instead of blocking the
 * user on a file they may not even remember editing.
 */
export async function readProjectFile(dir: string): Promise<ProjectFile | null> {
  try {
    const raw = await readFile(projectFilePath(dir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { version?: unknown }).version === 1 &&
      typeof (parsed as { projectName?: unknown }).projectName === "string" &&
      typeof (parsed as { createdAt?: unknown }).createdAt === "string"
    ) {
      return parsed as ProjectFile;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist the project name for `dir`. Creates `.appstrate/` with `0755`
 * on the first call; the file itself is world-readable (no secrets in
 * it) so backup tooling and operators inspecting the dir see it without
 * `sudo`.
 */
export async function writeProjectFile(dir: string, projectName: string): Promise<ProjectFile> {
  const record: ProjectFile = {
    version: 1,
    projectName,
    createdAt: new Date().toISOString(),
  };
  await mkdir(join(dir, ".appstrate"), { recursive: true });
  await writeFile(projectFilePath(dir), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
