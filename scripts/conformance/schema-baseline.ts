// SPDX-License-Identifier: Apache-2.0

/**
 * Tool input-schema drift detection via committed golden baselines.
 *
 * Manifests carry no input schemas (a remote integration's `tools_policy`
 * only allowlists names + scopes; the server is the schema's source of
 * truth). So "schema conformance" can't be a manifest diff — it's a snapshot
 * diff: record each tool's live `inputSchema` to `baselines/<pkg>.json`, then
 * fail-soft (WARN) when a later run sees a different shape for the same tool.
 *
 * Name-level add/remove is already covered by the parity diff; this focuses
 * strictly on "same tool name, changed signature". Baselines are refreshed
 * with `--update-baselines` and reviewed like any committed fixture.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Finding } from "./types.ts";
import type { LiveTool } from "./mcp-list.ts";

const CHECK = "schema-drift";
export const BASELINE_DIR = join(import.meta.dir, "baselines");

interface Baseline {
  tools: Record<string, unknown>;
}

/** Stable, key-sorted JSON so semantically-equal schemas compare equal. */
export function canonicalize(value: unknown): string {
  const seen = new WeakSet<object>();
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return null;
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(norm);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = norm((v as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(norm(value));
}

function baselineFile(packageId: string): string {
  return join(BASELINE_DIR, `${packageId.replace(/[^a-z0-9-]+/gi, "_")}.json`);
}

/** Read a package's baseline, or null when none is committed yet. */
export async function loadBaseline(packageId: string): Promise<Baseline | null> {
  try {
    const raw = await readFile(baselineFile(packageId), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "tools" in parsed) {
      return parsed as Baseline;
    }
    return null;
  } catch {
    return null;
  }
}

/** Write/refresh a package's baseline from the current live tools. */
export async function writeBaseline(packageId: string, tools: LiveTool[]): Promise<void> {
  await mkdir(BASELINE_DIR, { recursive: true });
  const map: Record<string, unknown> = {};
  for (const t of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    map[t.name] = t.inputSchema ?? null;
  }
  await writeFile(baselineFile(packageId), JSON.stringify({ tools: map }, null, 2) + "\n");
}

/**
 * Diff live tool schemas against the baseline. WARN per tool whose schema
 * changed (monitor severity — upstream evolves; surface, don't gate). Tools
 * absent from the baseline are ignored here (name parity owns add/remove).
 * Returns an empty array when no baseline exists (uncovered).
 */
export function diffSchemas(packageId: string, live: LiveTool[], baseline: Baseline): Finding[] {
  const findings: Finding[] = [];
  for (const tool of live) {
    if (!(tool.name in baseline.tools)) continue; // new tool → name parity handles it
    const before = canonicalize(baseline.tools[tool.name]);
    const after = canonicalize(tool.inputSchema ?? null);
    if (before !== after) {
      findings.push({
        packageId,
        check: CHECK,
        severity: "warn",
        message: `tool "${tool.name}" inputSchema changed from the committed baseline (run --update-baselines after reviewing)`,
      });
    }
  }
  return findings;
}
