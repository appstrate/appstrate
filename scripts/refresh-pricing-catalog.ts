// SPDX-License-Identifier: Apache-2.0

/**
 * Refresh the vendored pricing + metadata catalog from upstream LiteLLM.
 *
 * Source: `BerriAI/litellm/litellm/model_prices_and_context_window_backup.json`
 * (MIT). Single industry-standard file carrying both pricing AND model
 * metadata (`max_input_tokens`, `supports_vision`, `mode`, …). The
 * catalog feeds the picker UI and the cost ledger.
 *
 * Output shape (per model, compact):
 *
 *   {
 *     "label": "Claude Haiku 4.5",       // optional, derived
 *     "contextWindow": 200000,
 *     "maxTokens": 64000,
 *     "capabilities": ["text","image","reasoning"],
 *     "cost": { "input": 1.0, "output": 5.0, "cacheRead": 0.1, "cacheWrite": 1.25 }
 *   }
 *
 * Why compact-projection (vs vendoring LiteLLM verbatim):
 *   - The upstream entry has ~20 fields per model; we read 8. Carrying the
 *     rest is dead weight and noisy in pricing-drift PRs.
 *   - Locking the shape at vendoring time means `pricing-catalog.ts` doesn't
 *     branch on upstream schema drift — that risk is contained here.
 *
 * Two modes:
 *   - **dry run** (default): downloads, diffs against the local files,
 *     prints a summary, exits 1 on drift. CI weekly workflow consumes this.
 *   - **apply** (`--apply`): writes the new content.
 *
 * Usage:
 *   bun scripts/refresh-pricing-catalog.ts          # dry run
 *   bun scripts/refresh-pricing-catalog.ts --apply  # write to disk
 */

import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const UPSTREAM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/litellm/model_prices_and_context_window_backup.json";
const REPO_ROOT = new URL("..", import.meta.url).pathname;
const DATA_DIR = resolve(REPO_ROOT, "apps/api/src/data/pricing");

/**
 * LiteLLM `litellm_provider` slug → our vendored-file basename.
 *
 * The right-hand side **MUST match a `ModelProviderDefinition.providerId`**
 * registered through the `core-providers` (or external) module. The
 * catalog lookup is keyed on `providerId` (not `apiShape`), because
 * multiple providers can share the same wire-format (cerebras, groq,
 * xai all use `openai-completions` apiShape with different upstreams +
 * different pricing).
 *
 * Adding a provider here without a matching `providerId` registration
 * is a no-op at runtime — the file gets written but `listCatalogModels`
 * never reaches it.
 */
const LITELLM_TO_OURS: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  mistral: "mistral",
  gemini: "google-ai",
  cerebras: "cerebras",
  groq: "groq",
  xai: "xai",
};

const PROVIDERS = Object.values(LITELLM_TO_OURS) as readonly string[];

/** Compact projection of one LiteLLM entry — the shape we vendor. */
interface CompactEntry {
  label?: string;
  contextWindow: number;
  maxTokens: number | null;
  capabilities: string[];
  cost: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

/** Subset of LiteLLM fields we consume. Everything else is ignored. */
interface LiteLLMEntry {
  litellm_provider?: string;
  mode?: string;
  max_input_tokens?: number;
  max_output_tokens?: number | null;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  supports_vision?: boolean;
  supports_reasoning?: boolean;
}

interface Summary {
  provider: string;
  localSize: number;
  upstreamSize: number;
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: boolean;
}

/**
 * Strip the routing namespace prefix LiteLLM uses for some entries
 * (`mistral/codestral-latest`, `azure/gpt-4o`, …). Our pricing lookup
 * keys on the canonical model id only.
 */
function canonicalId(rawKey: string): string {
  const slash = rawKey.lastIndexOf("/");
  return slash === -1 ? rawKey : rawKey.slice(slash + 1);
}

/**
 * Derive a display label from the model id. LiteLLM doesn't carry one,
 * and our picker prefers a human-readable name. Kept conservative —
 * only collapses `-`/`_` to spaces, capitalises tokens. Callers that
 * want pretty names (e.g. "Claude Haiku 4.5") override via the
 * `core-providers/index.ts` featured whitelist where they ALSO supply
 * a label.
 */
function deriveLabel(id: string): string {
  return id
    .replace(/[-_]/g, " ")
    .split(" ")
    .map((word) => (word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/**
 * Convert one LiteLLM entry to our compact shape. Returns null when the
 * entry has no usable pricing (e.g. embeddings, deprecated entries) —
 * caller drops those.
 */
function projectEntry(id: string, entry: LiteLLMEntry): CompactEntry | null {
  if (
    typeof entry.input_cost_per_token !== "number" ||
    typeof entry.output_cost_per_token !== "number" ||
    typeof entry.max_input_tokens !== "number"
  ) {
    return null;
  }
  const caps: string[] = ["text"];
  if (entry.supports_vision) caps.push("image");
  if (entry.supports_reasoning) caps.push("reasoning");

  // LiteLLM stores USD/token; our `ModelCost` is USD per 1M tokens.
  // Round to 6 decimals (parts-per-million precision = $1 per trillion
  // tokens) to clean up float artifacts like `0.09999999999999999`.
  const PER_MILLION = 1_000_000;
  const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
  const cost: CompactEntry["cost"] = {
    input: round(entry.input_cost_per_token * PER_MILLION),
    output: round(entry.output_cost_per_token * PER_MILLION),
  };
  if (typeof entry.cache_read_input_token_cost === "number") {
    cost.cacheRead = round(entry.cache_read_input_token_cost * PER_MILLION);
  }
  if (typeof entry.cache_creation_input_token_cost === "number") {
    cost.cacheWrite = round(entry.cache_creation_input_token_cost * PER_MILLION);
  }

  return {
    label: deriveLabel(id),
    contextWindow: entry.max_input_tokens,
    maxTokens: typeof entry.max_output_tokens === "number" ? entry.max_output_tokens : null,
    capabilities: caps,
    cost,
  };
}

/**
 * Group LiteLLM entries by provider + filter to `mode=chat` + project to
 * compact shape. Dedupes namespace-aliased keys (e.g.
 * `mistral/codestral-latest` collapses onto `codestral-latest`); when both
 * exist, prefer the plain entry (which is what users type).
 */
function buildProviderSnapshot(
  upstream: Record<string, LiteLLMEntry>,
  litellmProvider: string,
): Record<string, CompactEntry> {
  const out: Record<string, CompactEntry> = {};
  // First pass — canonical (plain) ids.
  for (const [key, entry] of Object.entries(upstream)) {
    if (entry.litellm_provider !== litellmProvider) continue;
    if (entry.mode !== "chat") continue;
    if (key.includes("/")) continue;
    const projected = projectEntry(key, entry);
    if (projected) out[key] = projected;
  }
  // Second pass — namespaced ids fill in gaps. Skips canonical ids
  // already populated above.
  for (const [key, entry] of Object.entries(upstream)) {
    if (entry.litellm_provider !== litellmProvider) continue;
    if (entry.mode !== "chat") continue;
    if (!key.includes("/")) continue;
    const id = canonicalId(key);
    if (out[id]) continue;
    const projected = projectEntry(id, entry);
    if (projected) out[id] = projected;
  }
  // Stable key order for clean diffs in pricing-drift PRs.
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

async function fetchUpstream(): Promise<Record<string, LiteLLMEntry>> {
  const res = await fetch(UPSTREAM_URL);
  if (!res.ok) throw new Error(`fetch ${UPSTREAM_URL} → HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, LiteLLMEntry>;
  // Remove LiteLLM's `sample_spec` synthetic top-level entry — it documents
  // the schema, not a real model.
  delete data.sample_spec;
  return data;
}

function readLocal(provider: string): Record<string, CompactEntry> {
  const path = `${DATA_DIR}/${provider}.json`;
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, CompactEntry>;
}

function diffSnapshots(
  local: Record<string, CompactEntry>,
  upstream: Record<string, CompactEntry>,
): Omit<Summary, "provider" | "localSize" | "upstreamSize"> {
  const localKeys = new Set(Object.keys(local));
  const upstreamKeys = new Set(Object.keys(upstream));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const k of upstreamKeys) {
    if (!localKeys.has(k)) {
      added.push(k);
    } else if (JSON.stringify(local[k]) !== JSON.stringify(upstream[k])) {
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
  const apply =
    (globalThis as { process?: { argv?: string[] } }).process?.argv?.includes("--apply") ?? false;
  console.log(`Refreshing pricing catalog from LiteLLM (apply=${apply})\n`);

  if (apply && !existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  const upstream = await fetchUpstream();
  const summaries: Summary[] = [];

  for (const [litellmProvider, ourName] of Object.entries(LITELLM_TO_OURS)) {
    const upstreamSnapshot = buildProviderSnapshot(upstream, litellmProvider);
    const local = readLocal(ourName);
    const diff = diffSnapshots(local, upstreamSnapshot);
    const summary: Summary = {
      provider: ourName,
      localSize: Object.keys(local).length,
      upstreamSize: Object.keys(upstreamSnapshot).length,
      ...diff,
    };
    summaries.push(summary);
    summarize(summary);

    if (apply && !diff.unchanged) {
      writeFileSync(
        `${DATA_DIR}/${ourName}.json`,
        JSON.stringify(upstreamSnapshot, null, 2) + "\n",
        "utf8",
      );
      console.log(`    → wrote ${DATA_DIR}/${ourName}.json`);
    }
  }

  const drift = summaries.some((s) => !s.unchanged);
  console.log(
    `\n${drift ? "DRIFT" : "OK"} — ${summaries.filter((s) => !s.unchanged).length}/${PROVIDERS.length} provider(s) changed`,
  );

  if (drift && !apply) {
    (globalThis as { process?: { exit?: (n: number) => never } }).process?.exit?.(1);
  }
}

await main();
