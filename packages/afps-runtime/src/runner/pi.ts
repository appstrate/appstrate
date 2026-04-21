// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Real-LLM BundleRunner backed by the Pi Coding Agent SDK.
 *
 * Pi is an optional peer dependency — the package still loads when
 * `@mariozechner/pi-coding-agent` is not installed; PiRunner itself
 * lazy-imports the SDK on first `.run()` call and surfaces a clear
 * install hint if the import fails.
 *
 * The runner never spawns a subprocess: the AFPS platform tools are
 * registered directly as Pi extensions, and their `execute` functions
 * push `AfpsEvent` values through the caller's sink in-process. This
 * keeps the contract identical to `MockRunner` — same events, same
 * envelope, same reducer semantics.
 */

import { renderPrompt } from "../bundle/prompt-renderer.ts";
import type { AfpsEvent, AfpsEventEnvelope } from "../types/afps-event.ts";
import { toRunEvent } from "../types/run-event.ts";
import type { RunError, RunResult } from "../types/run-result.ts";
import { reduceEvents } from "./reducer.ts";
import type { BundleRunner, RunBundleOptions } from "./types.ts";
import { registerAfpsTools, type AfpsEventEmitter, type PiExtensionRegistrar } from "./pi-tools.ts";

/** Supported Pi `model.api` identifiers (subset sufficient for bundle runs). */
export type PiModelApi =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses"
  | "google-generative-ai"
  | "mistral-conversations";

export interface PiModelConfig {
  /** Model id (e.g. `claude-opus-4-7`, `gpt-4o-mini`). */
  id: string;
  /** Pi API identifier — determines the provider wire format. */
  api: PiModelApi;
  /** Provider slug (`anthropic`, `openai`, …). Derived from `api` when omitted. */
  provider?: string;
  /** Override base URL — e.g. a self-hosted Anthropic-compatible endpoint. */
  baseUrl?: string;
  /** Context window size used by Pi for compaction heuristics. */
  contextWindow?: number;
  /** Max output tokens. */
  maxTokens?: number;
  /** Enable extended thinking if the provider supports it. */
  reasoning?: boolean;
}

export interface PiRunnerOptions {
  model: PiModelConfig;
  /** Provider API key — forwarded to Pi's AuthStorage. */
  apiKey: string;
  /** Working directory for Pi's filesystem tools. Defaults to an ephemeral tmp dir. */
  cwd?: string;
  /** Pi's agent config directory. Defaults to `<cwd>/.pi-agent`. */
  agentDir?: string;
  thinkingLevel?: "off" | "low" | "medium" | "high";
  /** Hook fired once the rendered system prompt is built (useful for tests / logging). */
  onPromptRendered?: (prompt: string) => void;
  /**
   * DI seam for tests: if set, PiRunner uses this instead of lazy-
   * loading `@mariozechner/pi-coding-agent`. Production callers omit
   * this and let the default factory talk to the real SDK.
   */
  sessionFactory?: PiSessionFactory;
}

/** Session built by a {@link PiSessionFactory}. */
export interface PiSessionHandle {
  /** Kick off the agent with the rendered prompt; resolves when the agent ends. */
  prompt(system: string, signal?: AbortSignal): Promise<void>;
}

/**
 * Factory building a Pi session. Receives the emitter the session's
 * tool extension must call for every AFPS event the agent emits.
 */
export type PiSessionFactory = (args: PiSessionFactoryArgs) => Promise<PiSessionHandle>;

export interface PiSessionFactoryArgs {
  options: PiRunnerOptions;
  systemPrompt: string;
  emit: AfpsEventEmitter;
}

const PROVIDER_FROM_API: Record<PiModelApi, string> = {
  "anthropic-messages": "anthropic",
  "openai-completions": "openai",
  "openai-responses": "openai",
  "google-generative-ai": "google",
  "mistral-conversations": "mistral",
};

export class PiRunner implements BundleRunner {
  readonly name = "pi-runner";
  private readonly opts: PiRunnerOptions;

  constructor(opts: PiRunnerOptions) {
    this.opts = opts;
  }

  async run(runOpts: RunBundleOptions): Promise<RunResult> {
    const { bundle, context, sink, contextProvider, signal } = runOpts;
    signal?.throwIfAborted();

    const rendered = await renderPrompt({
      template: bundle.prompt,
      context,
      provider: contextProvider,
    });
    this.opts.onPromptRendered?.(rendered);

    const collected: AfpsEvent[] = [];
    let sequence = 0;
    const emit: AfpsEventEmitter = async (event) => {
      collected.push(event);
      const envelope: AfpsEventEnvelope = {
        runId: context.runId,
        sequence: sequence++,
        event,
      };
      if (sink.handle) {
        await sink.handle(toRunEvent({ event, runId: context.runId }));
      }
      if (sink.onEvent) await sink.onEvent(envelope);
    };

    const factory = this.opts.sessionFactory ?? defaultSessionFactory;

    let runError: RunError | undefined;
    try {
      const session = await factory({ options: this.opts, systemPrompt: rendered, emit });
      await session.prompt(rendered, signal);
    } catch (err) {
      runError = {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      };
      // Surface the error on the event stream so sinks can observe it
      // before finalize — matches MockRunner semantics.
      await emit({ type: "log", level: "error", message: runError.message });
    }

    const result = reduceEvents(collected, { error: runError });
    await sink.finalize(result);
    return result;
  }
}

/**
 * Default Pi session factory — lazy-loads the SDK, wires AuthStorage,
 * DefaultResourceLoader, the AFPS tool extension (with TypeBox-backed
 * parameters from `@mariozechner/pi-ai`), and returns a handle whose
 * `prompt()` dispatches to `session.prompt(systemPrompt)`.
 */
const defaultSessionFactory: PiSessionFactory = async ({ options, systemPrompt, emit }) => {
  const pi = await loadPiSdk();
  const modelProvider = options.model.provider ?? PROVIDER_FROM_API[options.model.api];
  if (!modelProvider) {
    throw new Error(`Unknown model.api '${options.model.api}' — set model.provider explicitly.`);
  }

  const { fs, os, path } = await loadNodeSupport();
  const cwd = options.cwd ?? (await fs.mkdtemp(path.join(os.tmpdir(), "afps-pi-run-")));
  const agentDir = options.agentDir ?? path.join(cwd, ".pi-agent");
  await fs.mkdir(agentDir, { recursive: true });

  const authStorage = pi.coding.AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(modelProvider, options.apiKey);

  const modelRegistry = pi.coding.ModelRegistry.inMemory(authStorage);

  const { Type } = pi.ai;
  const parametersFactory = {
    addMemory: Type.Object({
      content: Type.String({ description: "Memory content (max ~2000 chars)." }),
    }),
    setState: Type.Object({
      state: Type.Any({ description: "Arbitrary JSON value stored as carry-over state." }),
    }),
    output: Type.Object({
      data: Type.Any({ description: "Structured output — objects are merge-patched." }),
    }),
    report: Type.Object({
      content: Type.String({ description: "One line of the human-readable report." }),
    }),
    log: Type.Object({
      level: Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")]),
      message: Type.String(),
    }),
  };

  const extensionFactory = (extensionPi: unknown) => {
    registerAfpsTools(extensionPi as PiExtensionRegistrar, { emit, parametersFactory });
  };

  const resourceLoader = new pi.coding.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: pi.coding.SettingsManager.inMemory(),
    extensionFactories: [extensionFactory],
    noExtensions: false,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt,
  });
  await resourceLoader.reload();

  const { session } = await pi.coding.createAgentSession({
    cwd,
    agentDir,
    model: {
      id: options.model.id,
      name: options.model.id,
      api: options.model.api,
      provider: modelProvider,
      baseUrl: options.model.baseUrl ?? "",
      reasoning: options.model.reasoning ?? false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: options.model.contextWindow ?? 128_000,
      maxTokens: options.model.maxTokens ?? 16_384,
    },
    thinkingLevel: options.thinkingLevel ?? "medium",
    authStorage,
    modelRegistry,
    resourceLoader,
    sessionManager: pi.coding.SessionManager.inMemory(),
    settingsManager: pi.coding.SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    }),
  });

  return {
    prompt: async (sys, signal) => {
      signal?.throwIfAborted();
      await session.prompt(sys);
    },
  };
};

async function loadPiSdk(): Promise<{
  coding: typeof import("@mariozechner/pi-coding-agent");
  ai: typeof import("@mariozechner/pi-ai");
}> {
  try {
    const [coding, ai] = await Promise.all([
      import("@mariozechner/pi-coding-agent"),
      import("@mariozechner/pi-ai"),
    ]);
    return { coding, ai };
  } catch (err) {
    throw new Error(
      "PiRunner requires '@mariozechner/pi-coding-agent' and '@mariozechner/pi-ai' to be installed.\n" +
        "  bun add @mariozechner/pi-coding-agent @mariozechner/pi-ai\n" +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function loadNodeSupport(): Promise<{
  fs: typeof import("node:fs/promises");
  os: typeof import("node:os");
  path: typeof import("node:path");
}> {
  const [fs, os, path] = await Promise.all([
    import("node:fs/promises"),
    import("node:os"),
    import("node:path"),
  ]);
  return { fs, os, path };
}
