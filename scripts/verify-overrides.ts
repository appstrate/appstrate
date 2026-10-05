// SPDX-License-Identifier: Apache-2.0
/// <reference types="bun" />

/**
 * Verify that every root `overrides` entry satisfies every range a workspace declares
 * for that package: an override replaces the version for the WHOLE tree, so a stale one
 * silently runs workspaces below their declared floor. The override's floor (`4.6.5` for
 * `^4.6.5` / `~4.6.5`) must satisfy each range.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export interface Manifest {
  path: string;
  json: Partial<Record<(typeof DEP_FIELDS)[number], Record<string, string>>>;
}

const FLOOR_RE = /^[\^~]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** The lowest version `value` admits, or `null` when it is not `x.y.z` / `^x.y.z` / `~x.y.z`. */
export function overrideFloor(value: string): string | null {
  return FLOOR_RE.exec(value.trim())?.[1] ?? null;
}

/** Every violation of `overrides` against the declared ranges of `manifests`. Pure. */
export function checkOverrides(
  overrides: Record<string, string>,
  manifests: readonly Manifest[],
): string[] {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(overrides)) {
    const floor = overrideFloor(value);
    if (floor === null) {
      problems.push(
        `overrides.${name} = \`${value}\` — use \`x.y.z\`, \`^x.y.z\` or \`~x.y.z\` so it can be checked.`,
      );
      continue;
    }
    for (const { path, json } of manifests) {
      for (const field of DEP_FIELDS) {
        const range = json[field]?.[name];
        // `workspace:`, `catalog:`, `npm:`, `file:`, git URLs… are not semver ranges.
        if (range === undefined || /^[a-z+]+:/i.test(range)) continue;
        if (!Bun.semver.satisfies(floor, range)) {
          problems.push(
            `overrides.${name} = \`${value}\` does not satisfy ${path} ${field}.${name} = \`${range}\`.`,
          );
        }
      }
    }
  }
  return problems;
}

/** The root manifest and every workspace manifest its `workspaces` globs match. */
export function loadManifests(root: string): {
  overrides: Record<string, string>;
  manifests: Manifest[];
} {
  const read = (path: string): Manifest => ({
    path,
    json: JSON.parse(readFileSync(join(root, path), "utf8")),
  });
  const rootJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    workspaces?: string[];
    overrides?: Record<string, string>;
  };
  const manifests = [read("package.json")];
  for (const pattern of rootJson.workspaces ?? []) {
    const glob = new Bun.Glob(`${pattern}/package.json`);
    for (const path of [...glob.scanSync({ cwd: root, onlyFiles: true })].sort()) {
      manifests.push(read(path));
    }
  }
  return { overrides: rootJson.overrides ?? {}, manifests };
}

if (import.meta.main) {
  const { overrides, manifests } = loadManifests(REPO_ROOT);
  const problems = checkOverrides(overrides, manifests);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`❌ ${problem}`);
    console.error(
      `\n${problems.length} override(s) contradict a declared range. Raise the override in the ` +
        `root package.json (or drop it), then \`bun install\`.`,
    );
    process.exit(1);
  }
  console.log(
    `✅ overrides consistent — ${Object.keys(overrides).length} override(s) against ` +
      `${manifests.length} manifest(s).`,
  );
}
