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
  deepseek: "deepseek",
  moonshot: "moonshot",
  together_ai: "together-ai",
  fireworks_ai: "fireworks-ai",
  zai: "zai",
};

/**
 * LiteLLM providers we snapshot WITHOUT vendoring into the pricing
 * catalog. `chatgpt` is the ChatGPT subscription backend (flat-fee — no
 * per-token pricing, entries carry no cost fields). The codex module is
 * a foreign-catalog provider exposing a curated `featuredModels` list,
 * never a full catalog, because the subscription serves a restricted,
 * moving set of models. The weekly diff on this snapshot is the review
 * signal for that curation (new subscription models, deprecations).
 * No Anthropic equivalent exists — LiteLLM carries no claude-
 * subscription provider, so the claude-code module's curation stays
 * manual.
 *
 * Snapshots land in `apps/api/src/data/subscription-watch/<name>.json`
 * as a sorted id array. Nothing imports them at runtime.
 */
const SUBSCRIPTION_WATCH: readonly string[] = ["chatgpt"];
const WATCH_DIR = resolve(REPO_ROOT, "apps/api/src/data/subscription-watch");

/**
 * Auto-featured generation — second source: [models.dev](https://models.dev)
 * (open data from the opencode project, no auth). LiteLLM carries no
 * release dates, so "newest models per provider" is not derivable from
 * it alone. models.dev carries `release_date` + `tool_call` per model.
 *
 * Featured = the {@link FEATURED_COUNT} newest models per provider in
 * the **intersection** of the vendored LiteLLM snapshot (pricing must
 * exist) and models.dev, filtered to `tool_call: true` (Appstrate
 * agents require tool-calling — a hard compatibility criterion, not an
 * editorial one). Output: `apps/api/src/data/featured-models.json`,
 * consumed by `core-providers` at boot. Hardcoding a list on a
 * provider definition still overrides (see core-providers/index.ts).
 *
 * Subscription-OAuth modules (codex, claude-code) keep manual curation
 * — models.dev doesn't describe subscription backends.
 */
const MODELSDEV_URL = "https://models.dev/api.json";
const FEATURED_PATH = resolve(REPO_ROOT, "apps/api/src/data/featured-models.json");
const FEATURED_COUNT = 3;

/** Our providerId → models.dev provider key (identity unless mapped). */
const OURS_TO_MODELSDEV: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  mistral: "mistral",
  "google-ai": "google",
  cerebras: "cerebras",
  groq: "groq",
  xai: "xai",
  deepseek: "deepseek",
  moonshot: "moonshotai",
  "together-ai": "togetherai",
  "fireworks-ai": "fireworks-ai",
  zai: "zai",
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
 *
 * Only the `<litellm_provider>/` prefix is stripped — the remainder IS
 * the model id. Several providers use multi-segment ids their API
 * actually expects (`together_ai/meta-llama/Llama-3.3-70B…` →
 * `meta-llama/Llama-3.3-70B…`, `fireworks_ai/accounts/fireworks/models/x`
 * → `accounts/fireworks/models/x`); collapsing to the last segment
 * would vendor ids the upstream API rejects. Keys namespaced under a
 * different prefix keep the last-segment fallback (identical output
 * for every single-segment-namespace provider).
 */
function canonicalId(rawKey: string, litellmProvider: string): string {
  const prefix = `${litellmProvider}/`;
  if (rawKey.startsWith(prefix)) return rawKey.slice(prefix.length);
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
    const id = canonicalId(key, litellmProvider);
    if (out[id]) continue;
    const projected = projectEntry(id, entry);
    if (projected) out[id] = projected;
  }
  // Stable key order for clean diffs in pricing-drift PRs.
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Subset of one models.dev model entry we consume. */
interface ModelsDevModel {
  release_date?: string;
  tool_call?: boolean;
}

interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>;
}

async function fetchModelsDev(): Promise<Record<string, ModelsDevProvider>> {
  const res = await fetch(MODELSDEV_URL);
  if (!res.ok) throw new Error(`fetch ${MODELSDEV_URL} → HTTP ${res.status}`);
  return (await res.json()) as Record<string, ModelsDevProvider>;
}

/**
 * Newest {@link FEATURED_COUNT} tool-calling models for one provider:
 * vendored snapshot ∩ models.dev, sorted by `release_date` desc (id asc
 * as deterministic tie-break).
 */
function buildFeatured(
  snapshot: Record<string, CompactEntry>,
  modelsDevModels: Record<string, ModelsDevModel>,
): string[] {
  return Object.entries(modelsDevModels)
    .filter(([id, m]) => snapshot[id] && m.tool_call === true && typeof m.release_date === "string")
    .sort(([idA, a], [idB, b]) => {
      if (a.release_date !== b.release_date) return a.release_date! < b.release_date! ? 1 : -1;
      return idA < idB ? -1 : 1;
    })
    .slice(0, FEATURED_COUNT)
    .map(([id]) => id);
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

  const [upstream, modelsDev] = await Promise.all([fetchUpstream(), fetchModelsDev()]);
  const summaries: Summary[] = [];
  const snapshots: Record<string, Record<string, CompactEntry>> = {};

  for (const [litellmProvider, ourName] of Object.entries(LITELLM_TO_OURS)) {
    const upstreamSnapshot = buildProviderSnapshot(upstream, litellmProvider);
    snapshots[ourName] = upstreamSnapshot;
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

  // Auto-featured — newest tool-calling models per provider (LiteLLM ∩
  // models.dev). One JSON for all providers; regenerated atomically with
  // the catalogs above so every featured id is guaranteed to exist in
  // its provider's vendored file (the boot-time check relies on this).
  {
    const upstreamFeatured: Record<string, string[]> = {};
    for (const ourName of Object.keys(OURS_TO_MODELSDEV).sort()) {
      const mdModels = modelsDev[OURS_TO_MODELSDEV[ourName]]?.models ?? {};
      upstreamFeatured[ourName] = buildFeatured(snapshots[ourName] ?? {}, mdModels);
      if (upstreamFeatured[ourName].length === 0) {
        console.log(`    ⚠ featured: empty intersection for ${ourName} (models.dev coverage gap)`);
      }
    }
    const localFeatured = existsSync(FEATURED_PATH)
      ? (JSON.parse(readFileSync(FEATURED_PATH, "utf8")) as Record<string, string[]>)
      : {};
    const changed = Object.keys(upstreamFeatured).filter(
      (p) => JSON.stringify(localFeatured[p] ?? []) !== JSON.stringify(upstreamFeatured[p]),
    );
    const summary: Summary = {
      provider: "featured",
      localSize: Object.values(localFeatured).flat().length,
      upstreamSize: Object.values(upstreamFeatured).flat().length,
      added: [],
      removed: [],
      changed,
      unchanged: changed.length === 0,
    };
    summaries.push(summary);
    summarize(summary);
    for (const p of changed) {
      console.log(
        `    ${p}: [${(localFeatured[p] ?? []).join(", ")}] → [${upstreamFeatured[p].join(", ")}]`,
      );
    }
    if (apply && !summary.unchanged) {
      writeFileSync(FEATURED_PATH, JSON.stringify(upstreamFeatured, null, 2) + "\n", "utf8");
      console.log(`    → wrote ${FEATURED_PATH}`);
    }
  }

  // Subscription-backend watch — ids only, never vendored as pricing.
  for (const litellmProvider of SUBSCRIPTION_WATCH) {
    const upstreamIds = [
      ...new Set(
        Object.entries(upstream)
          .filter(([, entry]) => entry.litellm_provider === litellmProvider)
          .map(([key]) => canonicalId(key, litellmProvider)),
      ),
    ].sort();
    const path = `${WATCH_DIR}/${litellmProvider}.json`;
    const localIds = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as string[]) : [];
    const localSet = new Set(localIds);
    const upstreamSet = new Set(upstreamIds);
    const added = upstreamIds.filter((id) => !localSet.has(id));
    const removed = localIds.filter((id) => !upstreamSet.has(id));
    const summary: Summary = {
      provider: `watch:${litellmProvider}`,
      localSize: localIds.length,
      upstreamSize: upstreamIds.length,
      added,
      removed,
      changed: [],
      unchanged: added.length === 0 && removed.length === 0,
    };
    summaries.push(summary);
    summarize(summary);
    if (!summary.unchanged) {
      console.log(
        `    ↳ subscription backend changed — review the curated featuredModels of the matching OAuth module(s)`,
      );
      if (apply) {
        if (!existsSync(WATCH_DIR)) mkdirSync(WATCH_DIR, { recursive: true });
        writeFileSync(path, JSON.stringify(upstreamIds, null, 2) + "\n", "utf8");
        console.log(`    → wrote ${path}`);
      }
    }
  }

  const drift = summaries.some((s) => !s.unchanged);
  console.log(
    `\n${drift ? "DRIFT" : "OK"} — ${summaries.filter((s) => !s.unchanged).length}/${summaries.length} snapshot(s) changed`,
  );

  if (drift && !apply) {
    (globalThis as { process?: { exit?: (n: number) => never } }).process?.exit?.(1);
  }
}

await main();
