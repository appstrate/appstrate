// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * `afps run` — execute an AFPS bundle against a real LLM.
 *
 * Drives the Pi Coding Agent SDK in-process (no Docker, no sidecar) via
 * `@appstrate/runner-pi`. Provider-authenticated tools are NOT supported
 * here — the Appstrate platform is the right place for those. This
 * command is meant for test runs, bug reproduction, and bundle
 * development outside the platform.
 *
 * `@appstrate/runner-pi` is pulled in via dynamic import so the base
 * `afps-runtime` package remains hermetically free of Pi SDK types and
 * code. The structural {@link RunnerPiModule} interface below mirrors
 * the subset of runner-pi's exports this command consumes; a change in
 * runner-pi's runtime shape is the only failure mode — tsc across the
 * two packages stays fully decoupled.
 *
 * Dependency injection via {@link createRunHandler} lets tests swap the
 * real dynamic import for a stub module exposing a scripted
 * `PiRunner` — no `mock.module()`, no hidden globals.
 */

import { parseArgs } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliIO } from "../index.ts";
import { readBundleFromBuffer } from "../../bundle/read.ts";
import type { Bundle } from "../../bundle/types.ts";
import { verifyBundleWithPolicy } from "../../bundle/signature-policy.ts";
import type { TrustRoot } from "../../bundle/signing.ts";
import { renderPlatformPrompt } from "../../bundle/platform-prompt.ts";
import type { ExecutionContext } from "../../types/execution-context.ts";
import type { EventSink } from "../../interfaces/event-sink.ts";
import { createReducerSink } from "../../sinks/reducer-sink.ts";
import { ConsoleSink } from "../../sinks/console-sink.ts";
import { FileSink } from "../../sinks/file-sink.ts";
import { CompositeSink } from "../../sinks/composite-sink.ts";

/**
 * Structural shape of the `@appstrate/runner-pi` exports this command
 * consumes. Kept local to avoid a hard type-level dependency on
 * runner-pi — the package imports `afps-runtime` transitively and a
 * reverse link would either force a circular workspace edge or pin
 * afps-runtime's tsc to runner-pi's installation.
 *
 * The interface is intentionally loose (`unknown` / minimal structural
 * constraints); precise typing would require importing runner-pi's
 * types, defeating the decoupling goal.
 */
export interface RunnerPiModule {
  PiRunner: new (opts: RunnerPiOptions) => {
    readonly name: string;
    // Intentionally permissive — PiRunner's RunOptions requires
    // resolvers it never reads at runtime. We pass no-ops.
    run(opts: Record<string, unknown>): Promise<void>;
  };
  prepareBundleForPi: (
    bundle: unknown,
    opts: { workspaceDir: string; onError?: (msg: string, err?: unknown) => void },
  ) => Promise<{
    extensionFactories: unknown[];
    cleanup: () => Promise<void>;
  }>;
}

export interface RunnerPiOptions {
  model: { api: string; id: string; baseUrl?: string; [k: string]: unknown };
  apiKey?: string;
  systemPrompt: string;
  startMessage?: string;
  cwd?: string;
  agentDir?: string;
  extensionFactories?: unknown[];
  thinkingLevel?: "low" | "medium" | "high";
}

export interface RunDeps {
  /** Dynamic-import `@appstrate/runner-pi`. Overridable in tests. */
  loadRunnerPi: () => Promise<RunnerPiModule>;
}

export const defaultDeps: RunDeps = {
  loadRunnerPi: async () => {
    // Dynamic import so tsc never sees an unresolved module in consumer
    // builds that don't install runner-pi.
    return (await import(
      /* @vite-ignore */ "@appstrate/runner-pi" as string
    )) as unknown as RunnerPiModule;
  },
};

const HELP = `afps run — execute a bundle against a real LLM (Pi Coding Agent SDK)

Usage:
  afps run <bundle> --api <api> --model <id> [options]

Drives a Pi Coding Agent session in-process (no Docker, no sidecar).
Provider-authenticated tools are NOT supported — use the Appstrate
platform for production runs. For scripted replay without an LLM,
use \`afps test\`.

Required:
  --api <api>            Pi SDK LLM API identifier
                         (anthropic-messages, openai-completions,
                          openai-responses, mistral-conversations,
                          google-generative-ai, …)
  --model <id>           Model identifier (e.g. claude-haiku-4-5-20251001)

Auth:
  --api-key <key>        LLM API key. Defaults to $AFPS_API_KEY
  --base-url <url>       Override LLM base URL (OpenRouter, custom gateways)

Context:
  --context <json>       Inline JSON ExecutionContext (runId, input).
                         Defaults to '{}' — pass '{"runId":"x","input":{…}}'
                         or use --context "$(cat context.json)" for big bodies
  --snapshot <path>      Path to JSON { memories?, state?, history? }
                         merged onto context

Output:
  --output <path>        Write final RunResult as JSON to <path>
  --sink console|file|both|none   Stream mode (default: console)
  --sink-file <path>     Path for --sink=file|both
                         (default: <bundle>.events.jsonl)

Execution:
  --timeout <seconds>    Abort run after N seconds (default: 300)
  --thinking-level low|medium|high   Pi SDK thinking level (default: medium)
  --trust-root <path>    Require signature + verify against this TrustRoot
  --workspace <dir>      Workspace for .pi/ + .agent-tools/
                         (default: tempdir, auto-cleanup)

Exit codes:
  0  success
  1  runtime error (LLM, network, tool)
  2  CLI usage error
  3  bundle invalid / signature rejected
  4  timeout
  130 SIGINT
`;

/**
 * Factory producing the command handler bound to a specific
 * {@link RunDeps}. The production handler is {@link run} below, bound
 * to {@link defaultDeps}. Tests construct their own handler with a stub
 * `loadRunnerPi`.
 */
export function createRunHandler(
  deps: RunDeps,
): (argv: readonly string[], io: CliIO) => Promise<number> {
  return async function run(argv: readonly string[], io: CliIO): Promise<number> {
    let parsed;
    try {
      parsed = parseArgs({
        args: [...argv],
        options: {
          api: { type: "string" },
          model: { type: "string" },
          "api-key": { type: "string" },
          "base-url": { type: "string" },
          context: { type: "string" },
          snapshot: { type: "string" },
          output: { type: "string" },
          sink: { type: "string" },
          "sink-file": { type: "string" },
          timeout: { type: "string" },
          "thinking-level": { type: "string" },
          "trust-root": { type: "string" },
          workspace: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
        strict: true,
        allowPositionals: true,
      });
    } catch (err) {
      io.stderr(`afps run: ${(err as Error).message}\n`);
      io.stderr(HELP);
      return 2;
    }
    if (parsed.values.help) {
      io.stdout(HELP);
      return 0;
    }

    const [bundlePath] = parsed.positionals;
    if (!bundlePath) {
      io.stderr("afps run: missing <bundle> argument\n");
      io.stderr(HELP);
      return 2;
    }

    const api = parsed.values.api;
    if (!api) {
      io.stderr("afps run: --api <api> is required\n");
      return 2;
    }

    const model = parsed.values.model;
    if (!model) {
      io.stderr("afps run: --model <id> is required\n");
      return 2;
    }

    const apiKey = parsed.values["api-key"] ?? process.env.AFPS_API_KEY;
    if (!apiKey) {
      io.stderr("afps run: missing API key (pass --api-key <key> or set $AFPS_API_KEY)\n");
      return 2;
    }

    // Load runner-pi early. Failure here is common enough (most users
    // who install afps-runtime won't have runner-pi) to deserve a
    // dedicated friendly message, not the generic dispatch-level catch.
    let runnerPi: RunnerPiModule;
    try {
      runnerPi = await deps.loadRunnerPi();
    } catch (err) {
      io.stderr(formatRunnerPiLoadError(err));
      return 1;
    }

    let bundle: Bundle;
    try {
      const bytes = await readFile(bundlePath);
      bundle = readBundleFromBuffer(new Uint8Array(bytes));
    } catch (err) {
      io.stderr(`afps run: invalid bundle: ${formatLoaderError(err)}\n`);
      return 3;
    }

    const trustRootPath = parsed.values["trust-root"];
    if (trustRootPath !== undefined) {
      let trustRoot: TrustRoot;
      try {
        trustRoot = await loadTrustRoot(trustRootPath);
      } catch (err) {
        io.stderr(`afps run: cannot read --trust-root: ${(err as Error).message}\n`);
        return 3;
      }
      try {
        verifyBundleWithPolicy(bundle, { policy: "required", trustRoot });
      } catch (err) {
        io.stderr(`afps run: signature check failed: ${(err as Error).message}\n`);
        return 3;
      }
    }

    let contextFile: ContextFile = {};
    const contextRaw = parsed.values.context;
    if (contextRaw !== undefined) {
      try {
        const parsedContext = JSON.parse(contextRaw) as unknown;
        if (
          parsedContext === null ||
          typeof parsedContext !== "object" ||
          Array.isArray(parsedContext)
        ) {
          throw new Error("--context must be a JSON object");
        }
        contextFile = parsedContext as ContextFile;
      } catch (err) {
        io.stderr(`afps run: invalid --context JSON: ${(err as Error).message}\n`);
        return 2;
      }
    }

    let snapshot: SnapshotFile = {};
    if (parsed.values.snapshot) {
      try {
        snapshot = (await readJson(parsed.values.snapshot)) as SnapshotFile;
      } catch (err) {
        io.stderr(`afps run: cannot read --snapshot: ${(err as Error).message}\n`);
        return 1;
      }
    }

    const context = assembleExecutionContext(contextFile, snapshot);

    const timeoutSeconds = parseTimeout(parsed.values.timeout, io);
    if (timeoutSeconds === null) return 2;

    const thinkingLevel = parsed.values["thinking-level"] as "low" | "medium" | "high" | undefined;
    if (
      thinkingLevel !== undefined &&
      thinkingLevel !== "low" &&
      thinkingLevel !== "medium" &&
      thinkingLevel !== "high"
    ) {
      io.stderr(
        `afps run: --thinking-level must be low|medium|high (got '${String(thinkingLevel)}')\n`,
      );
      return 2;
    }

    const sinkMode = (parsed.values.sink as string | undefined) ?? "console";
    if (!["console", "file", "both", "none"].includes(sinkMode)) {
      io.stderr(`afps run: unknown --sink '${sinkMode}' (console|file|both|none)\n`);
      return 2;
    }

    // Reducer sink is ALWAYS composed — it produces the final RunResult
    // for --output. Observation sinks (console/file) stream alongside.
    const reducer = createReducerSink();
    const sinks: EventSink[] = [reducer.sink];
    if (sinkMode === "console" || sinkMode === "both") {
      sinks.push(new ConsoleSink({ out: { write: (chunk) => io.stdout(chunk) } }));
    }
    if (sinkMode === "file" || sinkMode === "both") {
      const sinkFile =
        (parsed.values["sink-file"] as string | undefined) ?? `${bundlePath}.events.jsonl`;
      sinks.push(new FileSink({ path: sinkFile }));
    }
    const eventSink: EventSink = sinks.length === 1 ? sinks[0]! : new CompositeSink(sinks);

    // Extract the raw prompt.md template from the bundle's root package
    // so the platform prompt can wrap it with the standard preamble.
    const rootPkg = bundle.packages.get(bundle.root);
    const promptBytes = rootPkg?.files.get("prompt.md");
    const template = promptBytes ? new TextDecoder().decode(promptBytes) : "";
    const manifest = (rootPkg?.manifest ?? {}) as Record<string, unknown>;
    const schemaVersion =
      typeof manifest.schemaVersion === "string" ? manifest.schemaVersion : undefined;

    const systemPrompt = renderPlatformPrompt({
      template,
      context,
      ...(schemaVersion ? { schemaVersion } : {}),
      platformName: "afps run",
      timeoutSeconds,
    });

    // Workspace: user-provided dirs are respected and NEVER cleaned up
    // (debug ergonomics). Tempdirs created here are auto-removed in
    // the finally block.
    const userWorkspace = parsed.values.workspace as string | undefined;
    const workspaceDir = userWorkspace ?? (await mkdtemp(join(tmpdir(), "afps-run-")));
    const ownsWorkspace = userWorkspace === undefined;

    const cleanupTasks: Array<() => Promise<void>> = [];
    if (ownsWorkspace) {
      cleanupTasks.push(async () => rm(workspaceDir, { recursive: true, force: true }));
    }

    // Abort plumbing: timeout OR SIGINT aborts the controller, the
    // PiRunner aborts its session, the sink observes an appstrate.error
    // event, finalize runs, and we surface the right exit code.
    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(new TimeoutAbort()),
      timeoutSeconds * 1000,
    );
    timeoutHandle.unref?.();
    const onSigint = (): void => controller.abort(new SigintAbort());
    process.on("SIGINT", onSigint);
    cleanupTasks.push(async () => {
      clearTimeout(timeoutHandle);
      process.off("SIGINT", onSigint);
    });

    try {
      let prepared: Awaited<ReturnType<RunnerPiModule["prepareBundleForPi"]>>;
      try {
        prepared = await runnerPi.prepareBundleForPi(bundle, {
          workspaceDir,
          onError: (msg) => io.stderr(`afps run: prepareBundleForPi: ${msg}\n`),
        });
      } catch (err) {
        io.stderr(`afps run: prepareBundleForPi failed: ${redact(errorMessage(err), apiKey)}\n`);
        return 1;
      }
      cleanupTasks.push(async () => prepared.cleanup());

      const provider = deriveProviderFromApi(api);
      if (!provider) {
        io.stderr(
          `afps run: unknown --api '${api}' (expected one of: ${Object.keys(PROVIDER_BY_API).join(", ")})\n`,
        );
        return 2;
      }

      // Pi SDK's Model type requires a full field set. Defaults below are
      // the same as runtime-pi/entrypoint.ts — they make the Pi session
      // boot without cost tracking (cost=0) but the LLM call itself works.
      const runner = new runnerPi.PiRunner({
        model: {
          id: model,
          name: model,
          api,
          provider,
          baseUrl: parsed.values["base-url"] ?? "",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
        apiKey,
        systemPrompt,
        extensionFactories: prepared.extensionFactories,
        ...(thinkingLevel ? { thinkingLevel } : {}),
      });

      try {
        await runner.run({
          bundle,
          context,
          providerResolver: noopProviderResolver,
          toolResolver: noopToolResolver,
          skillResolver: noopSkillResolver,
          eventSink,
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          const reason = controller.signal.reason;
          if (reason instanceof TimeoutAbort) {
            io.stderr(`afps run: run timed out after ${timeoutSeconds}s\n`);
            return 4;
          }
          if (reason instanceof SigintAbort) {
            io.stderr("afps run: interrupted\n");
            return 130;
          }
        }
        io.stderr(`afps run: runner error: ${redact(errorMessage(err), apiKey)}\n`);
        return 1;
      }

      const result = reducer.snapshot();

      const outputPath = parsed.values.output as string | undefined;
      if (outputPath) {
        await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");
        io.stdout(`→ wrote RunResult to ${outputPath}\n`);
      }

      if (result.error) {
        io.stderr(`afps run: run finished with error: ${redact(result.error.message, apiKey)}\n`);
        return 1;
      }
      return 0;
    } finally {
      // Run cleanups in reverse order so the workspace (created first)
      // is removed last — after prepareBundleForPi.cleanup — to avoid
      // double-unlink races on shared subtrees.
      for (const task of cleanupTasks.reverse()) {
        try {
          await task();
        } catch {
          /* swallow cleanup errors — the primary exit code is already set */
        }
      }
    }
  };
}

/**
 * Mirrors `deriveProviderFromApi` in `@appstrate/runner-pi`. Duplicated
 * here to keep afps-runtime's tsc decoupled from runner-pi's internals.
 * Must stay in sync — runner-pi stores the API key under the derived
 * provider, Pi SDK looks it up via `model.provider`, so any drift breaks
 * auth.
 */
const PROVIDER_BY_API: Record<string, string> = {
  "anthropic-messages": "anthropic",
  "openai-completions": "openai",
  "openai-responses": "openai",
  "mistral-conversations": "mistral",
  "google-generative-ai": "google",
  "google-vertex": "google-vertex",
  "azure-openai-responses": "azure-openai-responses",
  "bedrock-converse-stream": "amazon-bedrock",
};

function deriveProviderFromApi(api: string): string | undefined {
  return PROVIDER_BY_API[api];
}

class TimeoutAbort {
  readonly kind = "timeout";
}

class SigintAbort {
  readonly kind = "sigint";
}

const noopProviderResolver = {
  async resolve(): Promise<unknown[]> {
    return [];
  },
};
const noopToolResolver = {
  async resolve(): Promise<unknown[]> {
    return [];
  },
};
const noopSkillResolver = {
  async resolve(): Promise<unknown[]> {
    return [];
  },
};

function parseTimeout(raw: string | undefined, io: CliIO): number | null {
  if (raw === undefined) return 300;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    io.stderr(`afps run: --timeout must be a positive number of seconds (got '${raw}')\n`);
    return null;
  }
  return n;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Remove substrings matching the current `apiKey` from a message before
 * surfacing it to the user. The API key ALWAYS flows through `--api-key`
 * or `$AFPS_API_KEY` under the caller's control, so global leakage is
 * not a risk here — this is belt-and-suspenders for logs pasted into
 * bug reports.
 *
 * Skip redaction for the empty-string edge case (not possible given the
 * earlier validation, but defensive).
 */
function redact(message: string, apiKey: string): string {
  if (!apiKey) return message;
  return message.split(apiKey).join("***");
}

interface ContextFile {
  runId?: string;
  input?: unknown;
  [key: string]: unknown;
}

interface SnapshotFile {
  memories?: ExecutionContext["memories"];
  history?: ExecutionContext["history"];
  state?: unknown;
}

/**
 * Assemble a runnable {@link ExecutionContext} from the optional
 * `--context` file and the optional `--snapshot` file. Snapshot keys
 * override corresponding context keys (matches `afps render` behaviour
 * so the two commands remain byte-identical given the same inputs).
 *
 * Exported for unit testing — the handler exercises it indirectly
 * through the Phase 3 runner invocation.
 */
export function assembleExecutionContext(
  contextFile: ContextFile,
  snapshot: SnapshotFile,
): ExecutionContext {
  return {
    runId: contextFile.runId ?? "cli-run",
    input: contextFile.input ?? {},
    ...contextFile,
    ...(snapshot.memories !== undefined ? { memories: snapshot.memories } : {}),
    ...(snapshot.history !== undefined ? { history: snapshot.history } : {}),
    ...(snapshot.state !== undefined ? { state: snapshot.state } : {}),
  };
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, "utf-8");
  return JSON.parse(text) as unknown;
}

async function loadTrustRoot(path: string): Promise<TrustRoot> {
  const raw = (await readJson(path)) as TrustRoot;
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as TrustRoot).keys)) {
    throw new Error("trust root must be an object with a `keys` array");
  }
  return raw;
}

/**
 * Minimal fs-error formatter that flattens `ENOENT: …` / BundleError
 * messages into a single short sentence. Bundle reader errors carry a
 * `code` plus `message` so tack the code onto the message for
 * debuggability.
 */
function formatLoaderError(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    return `${(err as { message: string }).message} [${String((err as { code: unknown }).code)}]`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Production handler — real dynamic import of `@appstrate/runner-pi`. */
export const run: (argv: readonly string[], io: CliIO) => Promise<number> =
  createRunHandler(defaultDeps);

/**
 * Build a user-facing message distinguishing a missing `runner-pi`
 * package from a missing `@mariozechner/pi-coding-agent` peer dep, so
 * the install hint actually helps.
 */
function formatRunnerPiLoadError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/@mariozechner\/pi-coding-agent/.test(message)) {
    return (
      `afps run: peer dependency '@mariozechner/pi-coding-agent' is not installed.\n` +
      `  Install it alongside runner-pi:\n` +
      `    bun add @appstrate/runner-pi @mariozechner/pi-coding-agent @mariozechner/pi-ai\n`
    );
  }
  if (/@appstrate\/runner-pi/.test(message) || /MODULE_NOT_FOUND/.test(message)) {
    return (
      `afps run: '@appstrate/runner-pi' is not installed.\n` +
      `  Install it to enable live execution:\n` +
      `    bun add @appstrate/runner-pi @mariozechner/pi-coding-agent @mariozechner/pi-ai\n`
    );
  }
  return `afps run: failed to load @appstrate/runner-pi: ${message}\n`;
}
