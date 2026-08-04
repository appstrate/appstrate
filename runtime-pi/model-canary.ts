// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLE_FORMAT_VERSION,
  bundleIntegrity,
  computeRecordEntries,
  recordIntegrity,
  serializeRecord,
  type Bundle,
  type BundlePackage,
  type PackageIdentity,
} from "@appstrate/afps-runtime/bundle";
import type { ModelApiShape } from "@appstrate/core/sidecar-types";
import type { RunResult } from "@appstrate/afps-runtime/runner";
import { createApp } from "./sidecar/app.ts";
import { createRuntimePiRunner } from "./pi-runner.ts";
import { parseRuntimeEnv } from "./env.ts";
import { buildRuntimeModel } from "./model.ts";

const STANDARD_MAX_TOKENS = 4;
const REASONING_MAX_TOKENS = 16;
const DEFAULT_TIMEOUT_MS = 30_000;
const CANARY_IDENTITY = "@appstrate/runtime-model-canary@1.0.0" as PackageIdentity;

export interface ModelRuntimeCanaryTarget {
  /** Public model id used inside the runtime (alias when aliased). */
  id: string;
  providerId: string;
  apiShape: ModelApiShape;
  baseUrl: string;
  apiKey: string;
  /** Real upstream model id. */
  modelId: string;
  aliased: boolean;
  reasoning: boolean | null;
  input: ReadonlyArray<"text" | "image"> | null;
  contextWindow: number | null;
  maxTokens: number | null;
  cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null;
}

export interface ModelRuntimeCanaryResult {
  id: string;
  providerId: string;
  modelId: string;
  ok: boolean;
  /** Direct target response status observed by the sidecar fetch boundary. */
  status: number | null;
  latencyMs: number;
  error?: string;
  usage?: RunResult["usage"];
  cost?: number;
}

export interface ModelRuntimeCanaryDeps {
  /** External provider boundary. Tests inject a fake; production uses global fetch. */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

function canaryBundle(): Bundle {
  const manifest = {
    name: "@appstrate/runtime-model-canary",
    version: "1.0.0",
    type: "agent",
  };
  const files = new Map<string, Uint8Array>([
    ["manifest.json", new TextEncoder().encode(JSON.stringify(manifest))],
  ]);
  const integrity = recordIntegrity(serializeRecord(computeRecordEntries(files)));
  const root: BundlePackage = { identity: CANARY_IDENTITY, manifest, files, integrity };
  const packageIndex = new Map([
    [CANARY_IDENTITY, { path: "packages/runtime-model-canary/1.0.0/", integrity }],
  ]);
  return {
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    root: CANARY_IDENTITY,
    packages: new Map([[CANARY_IDENTITY, root]]),
    integrity: bundleIntegrity(packageIndex),
  };
}

function captureSink(): {
  finalized: RunResult | null;
  handle: () => Promise<void>;
  finalize: (result: RunResult) => Promise<void>;
} {
  const sink = {
    finalized: null as RunResult | null,
    async handle() {},
    async finalize(result: RunResult) {
      sink.finalized = result;
    },
  };
  return sink;
}

/**
 * Execute one minimal inference through the production Pi adapter and Hono
 * sidecar. The provider call is the only mocked seam in tests.
 */
export async function runModelRuntimeCanary(
  target: ModelRuntimeCanaryTarget,
  deps: ModelRuntimeCanaryDeps = {},
): Promise<ModelRuntimeCanaryResult> {
  const root = await mkdtemp(join(tmpdir(), "appstrate-model-canary-"));
  const agentDir = join(root, "agent");
  const placeholder = `appstrate-canary-${crypto.randomUUID()}`;
  const startedAt = performance.now();
  let upstreamStatus: number | null = null;
  let server: ReturnType<typeof Bun.serve> | undefined;

  try {
    await mkdir(agentDir, { recursive: true });
    const externalFetch = deps.fetchFn ?? fetch;
    const observedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await externalFetch(input, init);
      upstreamStatus = response.status;
      return response;
    }) as typeof fetch;
    const app = createApp({
      config: {
        platformApiUrl: "http://model-canary.invalid",
        runToken: "model-canary",
        proxyUrl: "",
        llm: {
          authMode: "api_key",
          baseUrl: target.baseUrl,
          apiKey: target.apiKey,
          placeholder,
          ...(target.aliased ? { modelSwap: { alias: target.id, real: target.modelId } } : {}),
        },
      },
      cookieJar: new Map(),
      fetchFn: observedFetch,
    });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });

    const tokenLimit = target.reasoning ? REASONING_MAX_TOKENS : STANDARD_MAX_TOKENS;
    const model = buildRuntimeModel(
      parseRuntimeEnv({
        AGENT_RUN_ID: `run_canary_${crypto.randomUUID()}`,
        APPSTRATE_SINK_URL: "https://model-canary.invalid/events",
        APPSTRATE_SINK_FINALIZE_URL: "https://model-canary.invalid/events/finalize",
        APPSTRATE_SINK_SECRET: "model-canary-sink-secret",
        AGENT_PROMPT: "You are a connectivity probe. Reply with OK.",
        MODEL_API: target.apiShape,
        MODEL_PROVIDER: target.providerId,
        MODEL_ID: target.aliased ? target.id : target.modelId,
        MODEL_BASE_URL: `${server.url.origin}/llm`,
        MODEL_API_KEY: placeholder,
        MODEL_REASONING: target.reasoning ? "true" : "false",
        MODEL_INPUT: JSON.stringify(target.input ?? ["text"]),
        MODEL_CONTEXT_WINDOW: String(target.contextWindow ?? 128_000),
        MODEL_MAX_TOKENS: String(
          target.maxTokens == null ? tokenLimit : Math.min(target.maxTokens, tokenLimit),
        ),
        MODEL_COST: JSON.stringify(target.cost ?? { input: 0, output: 0 }),
        SIDECAR_URL: server.url.origin,
      }),
    );
    if (target.providerId === "openrouter" && model.api === "openai-completions") {
      model.compat = {
        ...model.compat,
        openRouterRouting: { allow_fallbacks: false, require_parameters: true },
      };
    }

    const sink = captureSink();
    const runner = createRuntimePiRunner({
      sidecarUrl: server.url.origin,
      model,
      apiKey: placeholder,
      systemPrompt: "You are a connectivity probe. Reply with OK.",
      startMessage: "Reply OK.",
      cwd: root,
      agentDir,
      authStoragePath: join(root, "auth.json"),
      disableModelRetry: true,
      disableTools: true,
    });
    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error(`Model canary timed out after ${deps.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`),
        ),
      deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      await runner.run({
        bundle: canaryBundle(),
        context: { runId: "run_model_canary", input: {}, memories: [], config: {} },
        eventSink: sink,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const finalized = sink.finalized;
    const ok =
      upstreamStatus !== null &&
      upstreamStatus >= 200 &&
      upstreamStatus < 300 &&
      finalized?.status === "success";
    return {
      id: target.id,
      providerId: target.providerId,
      modelId: target.modelId,
      ok,
      status: upstreamStatus,
      latencyMs: Math.round(performance.now() - startedAt),
      ...(finalized?.error?.message ? { error: finalized.error.message } : {}),
      ...(finalized?.usage ? { usage: finalized.usage } : {}),
      ...(finalized?.cost !== undefined ? { cost: finalized.cost } : {}),
    };
  } catch (error) {
    return {
      id: target.id,
      providerId: target.providerId,
      modelId: target.modelId,
      ok: false,
      status: upstreamStatus,
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (server) await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}
