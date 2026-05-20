// SPDX-License-Identifier: Apache-2.0

/**
 * Pure transform for the `dependencies.tools` → `runtimeTools` boot
 * migration. Kept free of any DB / env import so it can be unit-tested in
 * isolation (the DB walk lives in {@link ./migrate-runtime-tools.ts}).
 *
 * The `tool` AFPS package type was removed: the former system tools
 * (output/log/note/pin/report) are now built-in runtime tools selected per
 * agent via the top-level `runtimeTools: string[]` manifest field
 * (`output` is always injected and never listed).
 *
 *   - `@appstrate/output`                → dropped (mandatory/auto-injected)
 *   - `@appstrate/{log,note,pin,report}` → added to `runtimeTools`
 *   - any other tool id                  → recorded in `unknown` for the
 *                                          caller to fail loud on
 */

import { SELECTABLE_RUNTIME_TOOLS } from "@appstrate/core/runtime-tools-catalog";

const SELECTABLE = new Set<string>(SELECTABLE_RUNTIME_TOOLS);

export interface MigratedManifest {
  manifest: Record<string, unknown>;
  changed: boolean;
}

/**
 * Transform a single manifest object (returns a new object). Collects
 * unknown tool ids into `unknown` for fail-loud reporting by the caller.
 */
export function migrateManifest(raw: unknown, unknown: Set<string>): MigratedManifest {
  if (!raw || typeof raw !== "object") return { manifest: {}, changed: false };
  const manifest = { ...(raw as Record<string, unknown>) };
  const deps = manifest.dependencies;
  if (!deps || typeof deps !== "object") return { manifest, changed: false };
  const depsObj = deps as Record<string, unknown>;
  const tools = depsObj.tools;
  if (!tools || typeof tools !== "object") return { manifest, changed: false };

  const selected = new Set<string>();
  for (const id of Object.keys(tools as Record<string, unknown>)) {
    const name = id.split("/").pop() ?? id;
    if (name === "output") continue; // mandatory — auto-injected
    if (SELECTABLE.has(name)) {
      selected.add(name);
    } else {
      unknown.add(id);
    }
  }

  // Strip dependencies.tools.
  const newDeps = { ...depsObj };
  delete newDeps.tools;
  const newManifest: Record<string, unknown> = { ...manifest, dependencies: newDeps };

  // Merge selected into existing runtimeTools (preserve any present).
  if (selected.size > 0) {
    const existing = Array.isArray(manifest.runtimeTools)
      ? (manifest.runtimeTools as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    newManifest.runtimeTools = [...new Set([...existing, ...selected])];
  }

  return { manifest: newManifest, changed: true };
}
