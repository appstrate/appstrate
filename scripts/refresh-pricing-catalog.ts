// SPDX-License-Identifier: Apache-2.0

/**
 * Refresh the vendored pricing catalog from upstream Portkey.
 *
 * Pulls the latest `configs.portkey.ai/pricing/<provider>.json` snapshots
 * (sourced from the [Portkey-AI/models](https://github.com/Portkey-AI/models)
 * repo, MIT) and writes them to `apps/api/src/data/pricing/` — the same
 * files consumed at runtime by `services/pricing-catalog.ts`.
 *
 * Two modes:
 *   - **dry run** (default): downloads, diffs against the local files,
 *     prints a summary, and exits 1 if anything changed. Useful for the
 *     weekly CI workflow that opens a "pricing drift" PR.
 *   - **apply** (`--apply`): writes the new content. Combined with `git
 *     diff` in CI, this yields a clean PR with the upstream changes.
 *
 * Why vendor at all (recap from `pricing-catalog.ts`):
 *   - Tier 0 self-hosting must work offline — boot can't depend on a
 *     remote URL.
 *   - Historical billing stability — a mid-quarter Portkey price drop
 *     shouldn't retroactively change last month's cost attribution.
 *   - Pinning data to the deployed code revision makes audits easy.
 *
 * Usage:
 *   bun scripts/refresh-pricing-catalog.ts          # dry run
 *   bun scripts/refresh-pricing-catalog.ts --apply  # write to disk
 */

import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const UPSTREAM_BASE = "https://configs.portkey.ai/pricing";
const REPO_ROOT = new URL("..", import.meta.url).pathname;
const DATA_DIR = resolve(REPO_ROOT, "apps/api/src/data/pricing");

/**
 * Providers we vendor. Must match the `PROVIDER_INDEX` keys in
 * `apps/api/src/services/pricing-catalog.ts` — adding one here without
 * also wiring `pricing-catalog.ts` is a no-op at runtime.
 */
const PROVIDERS = ["openai", "anthropic", "mistral-ai", "google"] as const;

type Provider = (typeof PROVIDERS)[number];

interface Summary {
  provider: Provider;
  localSize: number;
  upstreamSize: number;
  added: string[];
  removed: string[];
  changed: string[]; // model ids whose JSON shape differs
  unchanged: boolean;
}

async function fetchUpstream(provider: Provider): Promise<unknown> {
  const url = `${UPSTREAM_BASE}/${provider}.json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch ${url} → HTTP ${res.status}`);
  }
  return (await res.json()) as unknown;
}

function readLocal(provider: Provider): unknown {
  const path = `${DATA_DIR}/${provider}.json`;
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function diffSnapshots(
  local: unknown,
  upstream: unknown,
): Omit<Summary, "provider" | "localSize" | "upstreamSize"> {
  const l = (local ?? {}) as Record<string, unknown>;
  const u = (upstream ?? {}) as Record<string, unknown>;
  const localKeys = new Set(Object.keys(l));
  const upstreamKeys = new Set(Object.keys(u));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const k of upstreamKeys) {
    if (!localKeys.has(k)) {
      added.push(k);
    } else if (JSON.stringify(l[k]) !== JSON.stringify(u[k])) {
      changed.push(k);
    }
  }
  for (const k of localKeys) {
    if (!upstreamKeys.has(k)) removed.push(k);
  }
  return {
    added,
    removed,
    changed,
    unchanged: added.length === 0 && removed.length === 0 && changed.length === 0,
  };
}

function summarize(s: Summary): void {
  const tag = s.unchanged ? "✔" : "✱";
  console.log(
    `${tag} ${s.provider.padEnd(12)} local=${s.localSize}  upstream=${s.upstreamSize}` +
      (s.unchanged
        ? `  (no changes)`
        : `  +${s.added.length} added  -${s.removed.length} removed  Δ${s.changed.length} changed`),
  );
  if (s.added.length)
    console.log(
      `    + ${s.added.slice(0, 8).join(", ")}${s.added.length > 8 ? `, …(+${s.added.length - 8})` : ""}`,
    );
  if (s.removed.length)
    console.log(
      `    - ${s.removed.slice(0, 8).join(", ")}${s.removed.length > 8 ? `, …(+${s.removed.length - 8})` : ""}`,
    );
  if (s.changed.length)
    console.log(
      `    Δ ${s.changed.slice(0, 8).join(", ")}${s.changed.length > 8 ? `, …(+${s.changed.length - 8})` : ""}`,
    );
}

async function main(): Promise<void> {
  // `process` is available in Bun without explicit type imports, but the
  // IDE TS config for the scripts/ dir doesn't pull in @types/node — keep
  // the runtime simple and avoid noisy `argv` typing.
  const apply =
    (globalThis as { process?: { argv?: string[] } }).process?.argv?.includes("--apply") ?? false;
  console.log(`Refreshing pricing catalog from ${UPSTREAM_BASE} (apply=${apply})\n`);

  if (apply && !existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  const summaries: Summary[] = [];
  for (const provider of PROVIDERS) {
    const [upstream, local] = await Promise.all([
      fetchUpstream(provider),
      Promise.resolve(readLocal(provider)),
    ]);
    const diff = diffSnapshots(local, upstream);
    const summary: Summary = {
      provider,
      localSize: Object.keys((local ?? {}) as Record<string, unknown>).length,
      upstreamSize: Object.keys((upstream ?? {}) as Record<string, unknown>).length,
      ...diff,
    };
    summaries.push(summary);
    summarize(summary);

    if (apply && !diff.unchanged) {
      writeFileSync(
        `${DATA_DIR}/${provider}.json`,
        JSON.stringify(upstream, null, 2) + "\n",
        "utf8",
      );
      console.log(`    → wrote ${DATA_DIR}/${provider}.json`);
    }
  }

  const drift = summaries.some((s) => !s.unchanged);
  console.log(
    `\n${drift ? "DRIFT" : "OK"} — ${summaries.filter((s) => !s.unchanged).length}/${summaries.length} provider(s) changed`,
  );

  // Exit code 1 on drift in dry-run mode so CI can detect the need for a
  // refresh PR. On `--apply`, exit 0 always — the caller (workflow) reads
  // `git diff` to decide whether to open a PR.
  if (drift && !apply) {
    (globalThis as { process?: { exit?: (n: number) => never } }).process?.exit?.(1);
  }
}

await main();
