// SPDX-License-Identifier: Apache-2.0

/**
 * The module packages outside `apps/api/src/modules/`: every `packages/module-<id>/`, and the
 * commercial `ee/` at the repository root (module id `enterprise`; it stays at the root by
 * licence decision). One roster for every gate and harness that discovers modules on disk.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface WorkspaceModuleRoot {
  /** Module id: `chat` for `packages/module-chat`, `enterprise` for `ee/`. */
  id: string;
  /** Package directory, relative to the repository root with `/` separators. */
  dir: string;
}

/** The commercial package: the one module directory under a licence other than Apache-2.0. */
export const COMMERCIAL_MODULE = { id: "enterprise", dir: "ee", spec: "@appstrate/ee" } as const;

/** Every workspace module package that has a `package.json`, sorted by directory. */
export function workspaceModuleRoots(repoRoot: string): WorkspaceModuleRoot[] {
  const packagesDir = join(repoRoot, "packages");
  const roots: WorkspaceModuleRoot[] = existsSync(packagesDir)
    ? readdirSync(packagesDir)
        .filter((name) => name.startsWith("module-"))
        .filter((name) => existsSync(join(packagesDir, name, "package.json")))
        .sort()
        .map((name) => ({ id: name.replace(/^module-/, ""), dir: `packages/${name}` }))
    : [];
  if (existsSync(join(repoRoot, COMMERCIAL_MODULE.dir, "package.json"))) {
    roots.push({ id: COMMERCIAL_MODULE.id, dir: COMMERCIAL_MODULE.dir });
  }
  return roots;
}
