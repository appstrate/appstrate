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
 *     "generation": { "temperature": "supported", "reasoning": { … } },
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
 *   - **apply** (`--apply`): writes the new content from a normalized exporter artifact.
 *
 * Usage:
 *   bun scripts/refresh-pricing-catalog.ts          # dry run
 *   LITELLM_CATALOG_PATH=/path/to/export.json \
 *     bun scripts/refresh-pricing-catalog.ts --apply
 */

import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type {
  ModelCapabilitySupport,
  ModelGenerationCapabilities,
  ModelNativeReasoningLevel,
  ModelReasoningLevel,
} from "@appstrate/core/model-generation";

const UPSTREAM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/litellm/model_prices_and_context_window_backup.json";
const REPO_ROOT = new URL("..", import.meta.url).pathname;
const DATA_DIR = resolve(REPO_ROOT, "apps/api/src/data/pricing");
const LITELLM_LOCK_PATH = resolve(REPO_ROOT, "scripts/litellm-catalog.lock.json");

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
 * subscription provider, but claude-code needs none: it declares a
 * catalog selector and re-derives from anthropic.json on every read.
 *
 * Snapshots land in `apps/api/src/data/subscription-watch/<name>.json`
 * as a sorted id array. Nothing imports them at RUNTIME; the blocking
 * drift gate (`apps/api/test/unit/services/curated-model-drift.test.ts`)
 * reads them at test time, unioned with the pricing catalog, because
 * most subscription-specific ids appear in no pricing catalog at all.
 * The snapshot is a lagging third-party feed, never an authority: the
 * vendor's own doc decides, and disagreements are recorded in
 * `subscription-watch/reviewed.json`.
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
  generation: ModelGenerationCapabilities;
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
  supports_sampling_params?: boolean;
  supports_none_reasoning_effort?: boolean;
  supports_minimal_reasoning_effort?: boolean;
  supports_low_reasoning_effort?: boolean;
  supports_xhigh_reasoning_effort?: boolean;
  supports_max_reasoning_effort?: boolean;
  supports_adaptive_thinking?: boolean;
  /** Added by the isolated pinned-LiteLLM exporter, never by the raw fallback. */
  _appstrate_supported_openai_params?: string[];
  /** Effective value-level contract computed by the pinned LiteLLM adapters. */
  _appstrate_generation?: {
    temperature: ModelCapabilitySupport;
    temperatureWithReasoning: ModelCapabilitySupport;
    reasoning: {
      supported: ModelCapabilitySupport;
      adaptive: boolean | null;
      levels: Partial<Record<ModelNativeReasoningLevel, ModelCapabilitySupport>>;
    };
  };
}

const NATIVE_REASONING_LEVELS: readonly ModelNativeReasoningLevel[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const CAPABILITY_SUPPORT_VALUES: readonly ModelCapabilitySupport[] = [
  "supported",
  "unsupported",
  "unknown",
];

/** Fail closed when a pinned exporter artifact lacks its normalized contract. */
function assertNormalizedGenerationCatalog(data: Record<string, LiteLLMEntry>): void {
  const vendoredProviders = new Set(Object.keys(LITELLM_TO_OURS));
  const isSupport = (value: unknown): value is ModelCapabilitySupport =>
    CAPABILITY_SUPPORT_VALUES.includes(value as ModelCapabilitySupport);
  let vendoredChatEntries = 0;

  for (const [modelId, entry] of Object.entries(data)) {
    if (entry.mode !== "chat" || !vendoredProviders.has(entry.litellm_provider ?? "")) continue;
    vendoredChatEntries += 1;

    const generation = entry._appstrate_generation;
    const levels = generation?.reasoning?.levels;
    const validLevels =
      levels != null &&
      Object.keys(levels).length === NATIVE_REASONING_LEVELS.length &&
      NATIVE_REASONING_LEVELS.every((level) => isSupport(levels[level]));
    const valid =
      generation != null &&
      isSupport(generation.temperature) &&
      isSupport(generation.temperatureWithReasoning) &&
      isSupport(generation.reasoning?.supported) &&
      (generation.reasoning?.adaptive === null ||
        typeof generation.reasoning?.adaptive === "boolean") &&
      validLevels;

    if (!valid) {
      throw new Error(
        `LiteLLM model ${modelId} has an invalid or missing _appstrate_generation contract`,
      );
    }
  }

  if (vendoredChatEntries === 0) {
    throw new Error("LiteLLM artifact contains no vendored chat entries");
  }
}

/** Verify that the artifact is the exact normalized output recorded by the lock. */
function assertNormalizedCatalogDigest(serialized: string, expectedDigest: unknown): void {
  if (typeof expectedDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) {
    throw new Error("LiteLLM lock is missing a valid normalizedDigest");
  }
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(serialized);
  const actualDigest = `sha256:${hasher.digest("hex")}`;
  if (actualDigest !== expectedDigest) {
    throw new Error(
      `LiteLLM normalized artifact digest mismatch: expected ${expectedDigest}, got ${actualDigest}`,
    );
  }
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
 * Cache-rate coverage of one provider snapshot, with its previous state.
 *
 * `cost.cacheRead` / `cost.cacheWrite` are emitted only when the upstream
 * LiteLLM entry carries the corresponding field ({@link projectEntry}), so
 * coverage is INHERITED and drifts week to week with no signal. The
 * consequence is not cosmetic: a model whose entry lacks `cacheRead` while
 * its provider reports cached tokens has those tokens priced at exactly
 * zero by the run-cost ledger. Surfacing the counts + delta in the weekly
 * PR body is what turns that drift into something a human reviews.
 */
interface CoverageRow {
  provider: string;
  entries: number;
  cacheRead: number;
  cacheWrite: number;
  /** Same three counts on the catalog currently vendored (the drift baseline). */
  prevEntries: number;
  prevCacheRead: number;
  prevCacheWrite: number;
}

interface CacheRateCounts {
  entries: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Count entries carrying each optional cache rate. Pure — unit-tested. */
function countCacheRates(snapshot: Record<string, CompactEntry>): CacheRateCounts {
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const entry of Object.values(snapshot)) {
    if (typeof entry.cost?.cacheRead === "number") cacheRead++;
    if (typeof entry.cost?.cacheWrite === "number") cacheWrite++;
  }
  return { entries: Object.keys(snapshot).length, cacheRead, cacheWrite };
}

/**
 * Coverage of `upstream` against the `local` file it replaces. `local` is the
 * snapshot the diff already read — no second read of the vendored files, and
 * the delta is computed BEFORE `--apply` overwrites them.
 */
function coverageRow(
  provider: string,
  local: Record<string, CompactEntry>,
  upstream: Record<string, CompactEntry>,
): CoverageRow {
  const now = countCacheRates(upstream);
  const before = countCacheRates(local);
  return {
    provider,
    entries: now.entries,
    cacheRead: now.cacheRead,
    cacheWrite: now.cacheWrite,
    prevEntries: before.entries,
    prevCacheRead: before.cacheRead,
    prevCacheWrite: before.cacheWrite,
  };
}

/** Markdown table for the weekly PR body. Pure — unit-tested. */
function formatCoverageSummary(rows: readonly CoverageRow[]): string {
  const delta = (now: number, before: number): string => {
    const d = now - before;
    return d === 0 ? "·" : d > 0 ? `+${d}` : `${d}`;
  };
  const share = (n: number, total: number): string =>
    total === 0 ? "—" : `${n} (${Math.round((n / total) * 100)}%)`;

  const lines = [
    "### Cache-rate coverage",
    "",
    "`cost.cacheRead` / `cost.cacheWrite` are vendored only when the upstream LiteLLM",
    "entry carries them, so this coverage is inherited and moves on its own. A model",
    "whose entry has no `cacheRead` while its provider reports cached tokens gets those",
    "tokens priced at exactly **zero**. The Δ columns are the change this PR makes —",
    "a large negative Δ means models lost their cache rate upstream.",
    "",
    "| Provider | Entries | Δ | cacheRead | Δ | cacheWrite | Δ |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const r of rows) {
    const flag = r.entries > 0 && r.cacheRead === 0 ? " ⚠️" : "";
    lines.push(
      `| \`${r.provider}\` | ${r.entries} | ${delta(r.entries, r.prevEntries)} ` +
        `| ${share(r.cacheRead, r.entries)}${flag} | ${delta(r.cacheRead, r.prevCacheRead)} ` +
        `| ${share(r.cacheWrite, r.entries)} | ${delta(r.cacheWrite, r.prevCacheWrite)} |`,
    );
  }

  const zero = rows.filter((r) => r.entries > 0 && r.cacheRead === 0).map((r) => r.provider);
  if (zero.length > 0) {
    lines.push(
      "",
      `⚠️ No \`cacheRead\` rate at all: ${zero.map((p) => `\`${p}\``).join(", ")} — every cached` +
        ` input token on these providers is currently billed at 0. Not a regression this PR` +
        ` introduces; it is the standing gap, restated so it stops being invisible.`,
    );
  }
  lines.push("");
  return lines.join("\n");
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

function support(value: boolean | undefined): ModelCapabilitySupport {
  return value === true ? "supported" : value === false ? "unsupported" : "unknown";
}

function deriveGenerationCapabilities(entry: LiteLLMEntry): ModelGenerationCapabilities {
  const exported = entry._appstrate_generation;
  if (exported) {
    return {
      temperature: exported.temperature,
      temperatureWithReasoning: exported.temperatureWithReasoning,
      reasoning: {
        supported: exported.reasoning.supported,
        adaptive: exported.reasoning.adaptive,
        levels: {
          off: exported.reasoning.levels.none ?? "unknown",
          minimal: exported.reasoning.levels.minimal ?? "unknown",
          low: exported.reasoning.levels.low ?? "unknown",
          medium: exported.reasoning.levels.medium ?? "unknown",
          high: exported.reasoning.levels.high ?? "unknown",
          xhigh: exported.reasoning.levels.xhigh ?? "unknown",
          max: exported.reasoning.levels.max ?? "unknown",
        },
      },
    };
  }

  const supportedParams = entry._appstrate_supported_openai_params;
  const hasSupportedReasoningLevel = [
    entry.supports_none_reasoning_effort,
    entry.supports_minimal_reasoning_effort,
    entry.supports_low_reasoning_effort,
    entry.supports_xhigh_reasoning_effort,
    entry.supports_max_reasoning_effort,
  ].some((value) => value === true);
  const temperature =
    entry.supports_sampling_params === false
      ? "unsupported"
      : supportedParams
        ? supportedParams.includes("temperature")
          ? "supported"
          : "unsupported"
        : "unknown";
  const reasoning: ModelCapabilitySupport =
    entry.supports_reasoning === false
      ? "unsupported"
      : entry.supports_reasoning === true ||
          hasSupportedReasoningLevel ||
          supportedParams?.includes("reasoning_effort") === true ||
          supportedParams?.includes("thinking") === true
        ? "supported"
        : "unknown";
  const levels: Partial<Record<ModelReasoningLevel, ModelCapabilitySupport>> = {
    off: support(entry.supports_none_reasoning_effort),
    minimal: support(entry.supports_minimal_reasoning_effort),
    // A general `supports_reasoning` fact confirms the control, not each
    // individual effort value. Keep unreported levels unknown rather than
    // inventing provider support that can turn into a 400 at inference time.
    low: support(entry.supports_low_reasoning_effort),
    medium: "unknown",
    high: "unknown",
    xhigh: support(entry.supports_xhigh_reasoning_effort),
    max: support(entry.supports_max_reasoning_effort),
  };

  return {
    temperature,
    reasoning: {
      supported: reasoning,
      adaptive:
        typeof entry.supports_adaptive_thinking === "boolean"
          ? entry.supports_adaptive_thinking
          : null,
      levels,
    },
  };
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
  const generation = deriveGenerationCapabilities(entry);
  const caps: string[] = ["text"];
  if (entry.supports_vision) caps.push("image");
  if (generation.reasoning.supported === "supported") caps.push("reasoning");

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

  // Canonical model invariant: a request spends `input + output` from the
  // same window, so `max_output_tokens < context_window` always holds.
  // LiteLLM reports `max_output_tokens == max_input_tokens` for a class of
  // models (devstral, kimi-k2.5, several grok/mistral entries) — a known
  // upstream data bug (LiteLLM #22478). Drop the impossible value to null
  // so the runtime derives a sane response reserve instead of inheriting a
  // cap that swallows the whole window (which crashes the sidecar at boot
  // and pins the compaction threshold at zero). See `@appstrate/core/token-budget`.
  const contextWindow = entry.max_input_tokens;
  const maxTokens =
    typeof entry.max_output_tokens === "number" && entry.max_output_tokens < contextWindow
      ? entry.max_output_tokens
      : null;

  return {
    label: deriveLabel(id),
    contextWindow,
    maxTokens,
    capabilities: caps,
    generation,
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
 * Real upstream model ids that must NEVER surface in the featured picker —
 * the hidden backings of model aliases (#727). Two sources, unioned:
 *   - `FEATURED_MODELS_EXCLUDE` (comma-separated) — covers backings configured
 *     as DB `org_models` rows, which this offline script can't see, and any
 *     manual additions.
 *   - `SYSTEM_PROVIDER_KEYS` aliased entries — best-effort JSON walk (no Zod, so
 *     a malformed env never breaks the catalog refresh; the explicit list still
 *     applies).
 * Lives here (not baked into the JSON) so the weekly auto-regen keeps excluding
 * them — `featured-models.json` is overwritten every run.
 */
function aliasedBackings(): Set<string> {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const out = new Set<string>();
  for (const id of (env?.FEATURED_MODELS_EXCLUDE ?? "").split(",").map((s) => s.trim())) {
    if (id) out.add(id);
  }
  const raw = env?.SYSTEM_PROVIDER_KEYS;
  if (raw) {
    try {
      const entries: unknown = JSON.parse(raw);
      if (Array.isArray(entries)) {
        for (const e of entries) {
          const models = (e as { models?: unknown })?.models;
          if (!Array.isArray(models)) continue;
          for (const m of models) {
            const mm = m as { aliased?: unknown; modelId?: unknown };
            if (mm?.aliased === true && typeof mm.modelId === "string") out.add(mm.modelId);
          }
        }
      }
    } catch {
      // Malformed SYSTEM_PROVIDER_KEYS — ignore; the explicit list still applies.
    }
  }
  return out;
}

/**
 * Newest {@link FEATURED_COUNT} tool-calling models for one provider:
 * vendored snapshot ∩ models.dev, sorted by `release_date` desc (id asc
 * as deterministic tie-break). Model-alias backings ({@link aliasedBackings})
 * are excluded so the picker never reveals what's behind an alias.
 */
function buildFeatured(
  provider: string,
  snapshot: Record<string, CompactEntry>,
  modelsDevModels: Record<string, ModelsDevModel>,
  excluded: ReadonlySet<string>,
): string[] {
  const ranked = Object.entries(modelsDevModels)
    .filter(([id, m]) => snapshot[id] && m.tool_call === true && typeof m.release_date === "string")
    .sort(([idA, a], [idB, b]) => {
      if (a.release_date !== b.release_date) return a.release_date! < b.release_date! ? 1 : -1;
      return idA < idB ? -1 : 1;
    })
    .map(([id]) => id);
  const dropped = ranked.filter((id) => excluded.has(id));
  if (dropped.length > 0) {
    console.log(
      `    → featured: excluding alias backing(s) for ${provider}: ${dropped.join(", ")}`,
    );
  }
  return ranked.filter((id) => !excluded.has(id)).slice(0, FEATURED_COUNT);
}

async function fetchUpstream(): Promise<Record<string, LiteLLMEntry>> {
  const artifactPath = process.env.LITELLM_CATALOG_PATH;
  const artifactContents = artifactPath ? readFileSync(artifactPath, "utf8") : null;
  const data = artifactContents
    ? (JSON.parse(artifactContents) as Record<string, LiteLLMEntry>)
    : await (async () => {
        const res = await fetch(UPSTREAM_URL);
        if (!res.ok) throw new Error(`fetch ${UPSTREAM_URL} → HTTP ${res.status}`);
        process.stderr.write(
          "WARNING: using the unpinned raw LiteLLM fallback; CI uses the pinned exporter artifact\n",
        );
        return (await res.json()) as Record<string, LiteLLMEntry>;
      })();
  if (artifactContents) {
    const lock = JSON.parse(readFileSync(LITELLM_LOCK_PATH, "utf8")) as {
      normalizedDigest?: unknown;
    };
    assertNormalizedCatalogDigest(artifactContents, lock.normalizedDigest);
    assertNormalizedGenerationCatalog(data);
  }
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

  if (apply && !process.env.LITELLM_CATALOG_PATH) {
    throw new Error(
      "--apply requires LITELLM_CATALOG_PATH from the pinned LiteLLM exporter; " +
        "the raw fallback does not contain value-level generation capabilities",
    );
  }

  if (apply && !existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  const [upstream, modelsDev] = await Promise.all([fetchUpstream(), fetchModelsDev()]);
  const summaries: Summary[] = [];
  const snapshots: Record<string, Record<string, CompactEntry>> = {};
  const coverageRows: CoverageRow[] = [];

  for (const [litellmProvider, ourName] of Object.entries(LITELLM_TO_OURS)) {
    const upstreamSnapshot = buildProviderSnapshot(upstream, litellmProvider);
    snapshots[ourName] = upstreamSnapshot;
    const local = readLocal(ourName);
    coverageRows.push(coverageRow(ourName, local, upstreamSnapshot));
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
    const excludedBackings = aliasedBackings();
    if (excludedBackings.size > 0) {
      console.log(`  Excluding ${excludedBackings.size} model-alias backing(s) from featured\n`);
    }
    for (const ourName of Object.keys(OURS_TO_MODELSDEV).sort()) {
      const mdModels = modelsDev[OURS_TO_MODELSDEV[ourName]]?.models ?? {};
      upstreamFeatured[ourName] = buildFeatured(
        ourName,
        snapshots[ourName] ?? {},
        mdModels,
        excludedBackings,
      );
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

  // Cache-rate coverage — always computed (it is a state report, not a diff),
  // printed for the local operator and, in CI, written to the path the caller
  // names.
  //
  // File over "parse it back out of stdout": this script's stdout already
  // interleaves per-provider diff lines, `→ wrote …` lines and warnings, so
  // fishing a markdown table out of it would need sentinel markers plus sed —
  // fragile, and silently truncating on the day someone adds a log line. An
  // explicit out-path is unambiguous. It MUST point outside the worktree
  // (the workflow uses `$RUNNER_TEMP`): `create-pull-request` commits every
  // change it finds, so a summary file in the repo would land in the very PR
  // it describes.
  const coverageMarkdown = formatCoverageSummary(coverageRows);
  console.log(`\n${coverageMarkdown}`);
  const coveragePath = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.PRICING_COVERAGE_SUMMARY_PATH;
  if (coveragePath) {
    writeFileSync(coveragePath, coverageMarkdown, "utf8");
    console.log(`→ wrote coverage summary to ${coveragePath}`);
  }

  const drift = summaries.some((s) => !s.unchanged);
  console.log(
    `\n${drift ? "DRIFT" : "OK"} — ${summaries.filter((s) => !s.unchanged).length}/${summaries.length} snapshot(s) changed`,
  );

  if (drift && !apply) {
    (globalThis as { process?: { exit?: (n: number) => never } }).process?.exit?.(1);
  }
}

// Guard the import-time side effect (network fetch + file writes) so the pure
// helpers below can be unit-tested without running the whole refresh.
if (import.meta.main) {
  await main();
}

export {
  aliasedBackings,
  assertNormalizedCatalogDigest,
  assertNormalizedGenerationCatalog,
  buildFeatured,
  countCacheRates,
  coverageRow,
  deriveGenerationCapabilities,
  formatCoverageSummary,
  projectEntry,
};
export type { CoverageRow };
