// SPDX-License-Identifier: Apache-2.0

/**
 * Live tool-surface snapshot — written per remote MCP server when the runner is
 * given `--snapshot-out <dir>`, then uploaded as a CI artifact by the monitor.
 *
 * Unlike a committed golden baseline, this is fetched fresh every run and never
 * committed: the artifact of one run is diffed against an earlier run's artifact
 * to inspect upstream drift (tool added/removed, description or schema changed).
 * No `--update-baselines` maintenance, no 3000 lines of fixtures in the repo —
 * the trade-off is that comparison is manual (artifacts, not a gating diff).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { LiveTool } from "./mcp-list.ts";

/** `@scope/name` → a filesystem-safe slug for the snapshot filename. */
export function snapshotSlug(packageId: string): string {
  return packageId.replace(/[^a-z0-9-]+/gi, "_");
}

/**
 * Write `<dir>/<slug>.json` = the full live tool surface (name + description +
 * inputSchema), sorted by name so two snapshots diff cleanly. Returns the path.
 */
export async function writeSnapshot(
  dir: string,
  packageId: string,
  tools: LiveTool[],
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const path = join(dir, `${snapshotSlug(packageId)}.json`);
  await writeFile(path, JSON.stringify({ packageId, tools: sorted }, null, 2) + "\n");
  return path;
}

/** Read a snapshot back (used by tests / ad-hoc comparison). */
export async function readSnapshot(
  dir: string,
  packageId: string,
): Promise<{ packageId: string; tools: LiveTool[] } | null> {
  try {
    const raw = await readFile(join(dir, `${snapshotSlug(packageId)}.json`), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "tools" in parsed) {
      return parsed as { packageId: string; tools: LiveTool[] };
    }
    return null;
  } catch {
    return null;
  }
}
