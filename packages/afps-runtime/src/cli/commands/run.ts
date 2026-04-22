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
import { readFile } from "node:fs/promises";
import type { CliIO } from "../index.ts";
import { readBundleFromBuffer } from "../../bundle/read.ts";
import type { Bundle } from "../../bundle/types.ts";
import { verifyBundleWithPolicy } from "../../bundle/signature-policy.ts";
import type { TrustRoot } from "../../bundle/signing.ts";
import type { ExecutionContext } from "../../types/execution-context.ts";

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
    run(opts: {
      bundle: unknown;
      context: unknown;
      providerResolver: unknown;
      toolResolver: unknown;
      skillResolver: unknown;
      eventSink: unknown;
      signal?: AbortSignal;
    }): Promise<void>;
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
  --context <path>       JSON ExecutionContext (runId, input). Defaults to {}
  --snapshot <path>      JSON { memories?, state?, history? } merged onto context

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
    if (parsed.values.context) {
      try {
        contextFile = (await readJson(parsed.values.context)) as ContextFile;
      } catch (err) {
        io.stderr(`afps run: cannot read --context: ${(err as Error).message}\n`);
        return 1;
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

    // Phase 2 scaffolding: bundle loaded, signature verified, context
    // assembled. Real execution lands in Phase 3.
    void api;
    void model;
    void apiKey;
    void runnerPi;
    void bundle;
    void context;
    io.stderr("afps run: runner orchestration not yet wired (Phase 3)\n");
    return 1;
  };
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
