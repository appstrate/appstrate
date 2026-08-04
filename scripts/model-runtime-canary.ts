// SPDX-License-Identifier: Apache-2.0

/**
 * Live model conformance canary.
 *
 * Reads the same shape as SYSTEM_PROVIDER_KEYS, resolves catalog-derived
 * metadata, then executes each selected model through runtime-pi's real Pi
 * adapter and Hono sidecar. The external provider is the only remote boundary.
 *
 * Required environment:
 *   MODEL_RUNTIME_CANARY_CONFIG (preferred) or SYSTEM_PROVIDER_KEYS
 *
 * Usage:
 *   bun scripts/model-runtime-canary.ts --all
 *   bun scripts/model-runtime-canary.ts --changed --base=HEAD
 */

import coreProvidersModule from "../apps/api/src/modules/core-providers/index.ts";
import {
  initSystemModelProviderKeys,
  getSystemModels,
} from "../apps/api/src/services/model-registry.ts";
import {
  getModelProvider,
  registerModelProviders,
  resetModelProviders,
} from "../apps/api/src/services/model-providers/registry.ts";
import { lookupCatalogModel } from "../apps/api/src/services/pricing-catalog.ts";
import {
  runModelRuntimeCanary,
  type ModelRuntimeCanaryResult,
  type ModelRuntimeCanaryTarget,
} from "../runtime-pi/model-canary.ts";

const PRICING_DIR = "apps/api/src/data/pricing";
const TRANSIENT_RETRY_DELAY_MS = 2_000;
const CONCURRENCY = 2;

interface Options {
  mode: "all" | "changed";
  base: string;
  requireTargets: boolean;
  modelIds: Set<string>;
}

type CatalogSnapshot = Record<
  string,
  {
    contextWindow?: number;
    maxTokens?: number | null;
    capabilities?: string[];
  }
>;

function parseOptions(argv: readonly string[]): Options {
  let mode: Options["mode"] = "all";
  let base = "HEAD";
  let requireTargets = false;
  const modelIds = new Set<string>();
  for (const arg of argv) {
    if (arg === "--all") mode = "all";
    else if (arg === "--changed") mode = "changed";
    else if (arg === "--require-targets") requireTargets = true;
    else if (arg.startsWith("--base=")) base = arg.slice("--base=".length);
    else if (arg.startsWith("--model=")) modelIds.add(arg.slice("--model=".length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { mode, base, requireTargets, modelIds };
}

function canaryConfig(): unknown[] {
  const raw = process.env.MODEL_RUNTIME_CANARY_CONFIG ?? process.env.SYSTEM_PROVIDER_KEYS;
  if (!raw) {
    throw new Error(
      "MODEL_RUNTIME_CANARY_CONFIG (or SYSTEM_PROVIDER_KEYS) is required; " +
        "use a dedicated low-quota credential and list every model this deployment must serve",
    );
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Model canary config must be a JSON array");
  return parsed;
}

function wireProjection(value: CatalogSnapshot[string] | undefined): string {
  if (!value) return "missing";
  return JSON.stringify({
    contextWindow: value.contextWindow ?? null,
    maxTokens: value.maxTokens ?? null,
    capabilities: [...(value.capabilities ?? [])].sort(),
  });
}

/** Return model ids whose runtime-affecting catalog metadata changed. */
export function changedCatalogModelIds(
  before: CatalogSnapshot,
  after: CatalogSnapshot,
): Set<string> {
  const out = new Set<string>();
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (wireProjection(before[id]) !== wireProjection(after[id])) out.add(id);
  }
  return out;
}

/**
 * Fail closed when no usable configuration exists, while treating a changed
 * run with no semantic drift (for example price-only updates) as a valid skip.
 */
export function shouldFailEmptyCanarySelection(input: {
  mode: Options["mode"];
  requireTargets: boolean;
  configuredTargetCount: number;
  explicitModelCount: number;
}): boolean {
  if (!input.requireTargets) return false;
  return input.configuredTargetCount === 0 || input.mode === "all" || input.explicitModelCount > 0;
}

async function changedCatalogKeys(base: string): Promise<Set<string>> {
  const diff = Bun.spawnSync({
    cmd: ["git", "diff", "--name-only", base, "--", PRICING_DIR],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (diff.exitCode !== 0) throw new Error(diff.stderr.toString().trim() || "git diff failed");
  const paths = diff.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".json"));
  const keys = new Set<string>();
  for (const path of paths) {
    const providerId = path.slice(path.lastIndexOf("/") + 1, -".json".length);
    const previous = Bun.spawnSync({
      cmd: ["git", "show", `${base}:${path}`],
      stdout: "pipe",
      stderr: "pipe",
    });
    const before =
      previous.exitCode === 0
        ? (JSON.parse(previous.stdout.toString()) as CatalogSnapshot)
        : ({} as CatalogSnapshot);
    const after = (await Bun.file(path).json()) as CatalogSnapshot;
    for (const modelId of changedCatalogModelIds(before, after)) {
      keys.add(`${providerId}/${modelId}`);
    }
  }
  return keys;
}

function resolveTargets(rawConfig: unknown[]): ModelRuntimeCanaryTarget[] {
  resetModelProviders();
  registerModelProviders(coreProvidersModule.modelProviders?.() ?? []);
  initSystemModelProviderKeys(rawConfig);
  const targets: ModelRuntimeCanaryTarget[] = [];
  for (const [id, def] of getSystemModels()) {
    if (def.enabled === false) continue;
    const provider = getModelProvider(def.providerId);
    if (!provider) continue;
    const catalogId = provider.catalogProviderId ?? def.providerId;
    const catalog = lookupCatalogModel(catalogId, def.modelId);
    const catalogInput = catalog?.capabilities.filter(
      (capability): capability is "text" | "image" =>
        capability === "text" || capability === "image",
    );
    targets.push({
      id,
      providerId: def.providerId,
      apiShape: def.apiShape,
      baseUrl: def.baseUrl,
      apiKey: def.apiKey,
      modelId: def.modelId,
      aliased: def.aliased === true,
      reasoning: def.reasoning ?? catalog?.capabilities.includes("reasoning") ?? null,
      input: (def.input as Array<"text" | "image"> | null) ?? catalogInput ?? null,
      contextWindow: def.contextWindow ?? catalog?.contextWindow ?? null,
      maxTokens: def.maxTokens ?? catalog?.maxTokens ?? null,
      cost: def.cost ?? catalog?.cost ?? null,
    });
  }
  return targets;
}

function isTransient(status: number | null): boolean {
  return status === 408 || status === 429 || (status !== null && status >= 500);
}

async function probeWithTransientRetry(
  target: ModelRuntimeCanaryTarget,
): Promise<ModelRuntimeCanaryResult> {
  const first = await runModelRuntimeCanary(target);
  if (first.ok || !isTransient(first.status)) return first;
  await Bun.sleep(TRANSIENT_RETRY_DELAY_MS);
  return runModelRuntimeCanary(target);
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await fn(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

function printResults(results: readonly ModelRuntimeCanaryResult[]): void {
  const lines = [
    "| Provider | Runtime id | Upstream model | Status | Latency | Tokens |",
    "| --- | --- | --- | ---: | ---: | ---: |",
  ];
  for (const result of results) {
    const status = result.status ?? "network";
    const tokens = result.usage
      ? (result.usage.input_tokens ?? 0) +
        (result.usage.output_tokens ?? 0) +
        (result.usage.cache_creation_input_tokens ?? 0) +
        (result.usage.cache_read_input_tokens ?? 0)
      : 0;
    lines.push(
      `| ${result.providerId} | ${result.id} | ${result.modelId} | ` +
        `${result.ok ? `✅ ${status}` : `❌ ${status}`} | ${result.latencyMs} ms | ${tokens} |`,
    );
    if (result.error) lines.push(`|  |  | error | ${result.error.replaceAll("|", "\\|")} |  |  |`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  const options = parseOptions(Bun.argv.slice(2));
  let targets = resolveTargets(canaryConfig());
  const configuredTargetCount = targets.length;
  if (options.modelIds.size > 0) {
    targets = targets.filter(
      (target) => options.modelIds.has(target.id) || options.modelIds.has(target.modelId),
    );
  }
  if (options.mode === "changed") {
    const changed = await changedCatalogKeys(options.base);
    targets = targets.filter((target) => {
      const provider = getModelProvider(target.providerId);
      const catalogId = provider?.catalogProviderId ?? target.providerId;
      return changed.has(`${catalogId}/${target.modelId}`);
    });
  }
  if (targets.length === 0) {
    const message = "No configured runtime model matched the requested canary selection.";
    process.stdout.write(`${message}\n`);
    if (
      shouldFailEmptyCanarySelection({
        mode: options.mode,
        requireTargets: options.requireTargets,
        configuredTargetCount,
        explicitModelCount: options.modelIds.size,
      })
    ) {
      throw new Error(message);
    }
    return;
  }
  const results = await mapConcurrent(targets, CONCURRENCY, probeWithTransientRetry);
  printResults(results);
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

if (import.meta.main) {
  await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
