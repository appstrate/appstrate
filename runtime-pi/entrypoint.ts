// SPDX-License-Identifier: Apache-2.0

/**
 * runtime-pi entrypoint — thin bootloader that wires the agent container
 * runtime into the shared {@link PiRunner}. The same `PiRunner` used
 * here is what external consumers instantiate against their own
 * {@link EventSink}; structural parity between in-container and out-of-
 * container execution is guaranteed by using the same class.
 *
 * Responsibilities (runtime-pi only):
 *   1. Initialise a git repo + extract the injected agent package.
 *   2. Install TOOL.md / skills / providers into `.pi/` for on-disk lookup.
 *   3. Collect tool extension factories (from agent package + built-ins).
 *   4. Build an {@link ExecutionContext} from env vars.
 *   5. Build an {@link HttpSink} against the platform's signed-event API.
 *   6. Instantiate {@link PiRunner} and `await runner.run(...)`.
 *
 * Wire protocol (agent ↔ platform): HMAC-signed CloudEvents over HTTP via
 * `@appstrate/afps-runtime/sinks.HttpSink`. Every runner — platform
 * container, CLI, GitHub Action — speaks the exact same protocol against
 * `/api/runs/:runId/events` and `/events/finalize`. No stdout parsing.
 *
 * Required env vars:
 *   - `APPSTRATE_SINK_URL`, `APPSTRATE_SINK_FINALIZE_URL`, `APPSTRATE_SINK_SECRET`
 *   - `AGENT_RUN_ID`, `AGENT_PROMPT`, `MODEL_API`, `MODEL_ID`
 *
 * Fatal failures (missing env, malformed bundle) post a single
 * `appstrate.error` event via HttpSink *and* a terminal failed
 * `RunResult` via finalize, then `process.exit(1)`. The platform's
 * container-monitor also synthesises a failed finalize on non-zero
 * exit — the CAS in `finalizeRemoteRun` guarantees idempotency.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { type Api, type Model } from "@mariozechner/pi-ai";
import {
  PiRunner,
  prepareBundleForPi,
  buildProviderExtensionFactories,
} from "@appstrate/runner-pi";
import { readBundleFromFile } from "@appstrate/afps-runtime/bundle";
import { HttpSink } from "@appstrate/afps-runtime/sinks";
import { SidecarProviderResolver, type ProviderResolver } from "@appstrate/afps-runtime/resolvers";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import { emptyRunResult } from "@appstrate/afps-runtime/runner";
import { wrapExtensionFactory } from "./extension-wrapper.ts";

// --- 0. Sink bootstrap ---
// Every runtime-pi invocation MUST come from a platform run that has
// already minted sink credentials + inserted a pending run row. We
// refuse to boot without them — running without a destination defeats
// the point of the unified protocol and would produce orphaned work.

const SINK_URL = process.env.APPSTRATE_SINK_URL;
const SINK_FINALIZE_URL = process.env.APPSTRATE_SINK_FINALIZE_URL;
const SINK_SECRET = process.env.APPSTRATE_SINK_SECRET;
const AGENT_RUN_ID = process.env.AGENT_RUN_ID;

if (!AGENT_RUN_ID || !SINK_URL || !SINK_FINALIZE_URL || !SINK_SECRET) {
  // Before the sink is live, stderr is the only channel — the platform's
  // container monitor will synthesise a `failed` finalize from the exit
  // code so the run record still reaches a terminal state.
  process.stderr.write(
    "runtime-pi: missing required sink env (AGENT_RUN_ID, APPSTRATE_SINK_URL, APPSTRATE_SINK_FINALIZE_URL, APPSTRATE_SINK_SECRET)\n",
  );
  process.exit(1);
}

const sink = new HttpSink({
  url: SINK_URL,
  finalizeUrl: SINK_FINALIZE_URL,
  runSecret: SINK_SECRET,
});

/**
 * Emit a best-effort `appstrate.error` event for a bootstrap failure. We
 * swallow sink errors here — the caller is about to `process.exit(1)` and
 * the platform's container-monitor will synthesise a finalize on exit.
 */
async function emitError(message: string, data?: Record<string, unknown>): Promise<void> {
  try {
    await sink.handle({
      type: "appstrate.error",
      timestamp: Date.now(),
      runId: AGENT_RUN_ID!,
      message,
      ...(data !== undefined ? { data } : {}),
    });
  } catch {
    // The sink POST failed — let the container exit with non-zero code.
    // Finalize synthesis on the server will record the failure.
  }
}

/**
 * Fatal bootstrap failure. Emits one `appstrate.error`, attempts to
 * finalize the run as `failed`, and exits. `finalize` is best-effort —
 * server-side synthesis covers the case where even finalize POST fails.
 */
async function die(message: string): Promise<never> {
  await emitError(message);
  try {
    const failureResult = emptyRunResult();
    failureResult.error = { message };
    failureResult.status = "failed";
    await sink.finalize(failureResult);
  } catch {
    // fall through
  }
  process.exit(1);
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

// --- 1. Init workspace ---

const WORKSPACE = process.env.WORKSPACE_DIR || "/workspace";

/** Create a minimal valid git repo via filesystem (avoids 3 subprocess spawns). */
async function initGitWorkspace(): Promise<void> {
  const gitDir = `${WORKSPACE}/.git`;
  await fs.mkdir(`${gitDir}/refs`, { recursive: true });
  await Promise.all([
    fs.writeFile(`${gitDir}/HEAD`, "ref: refs/heads/main\n"),
    fs.writeFile(`${gitDir}/config`, "[user]\n\temail = pi@appstrate.local\n\tname = Pi\n"),
  ]);
}

// --- 2. Load tools ---

const extensionFactories: ExtensionFactory[] = [];
const loadedRuntimeIds = new Set<string>();

/**
 * Load platform-shipped extensions from the container's `/runtime/extensions/`
 * directory. These are Pi-bundled tools (e.g. built-in primitives) that do
 * not travel inside the AFPS bundle — kept here because the shared
 * `prepareBundleForPi` intentionally only handles bundle-scoped tools.
 */
async function loadExtensionsFromDir(dir: string, label: string) {
  if (!(await exists(dir))) return;
  const entries = (await fs.readdir(dir)).filter((e) => e.endsWith(".ts"));

  const results = await Promise.allSettled(
    entries
      .filter((e) => !loadedRuntimeIds.has(e.replace(/\.ts$/, "")))
      .map(async (entry) => {
        const id = entry.replace(/\.ts$/, "");
        const mod = await import(path.join(dir, entry));
        const factory = mod.default;
        if (typeof factory !== "function") {
          await emitError(
            `Extension '${id}' (${label}): default export is not a function (got ${typeof factory})`,
          );
          return;
        }
        extensionFactories.push(wrapExtensionFactory(factory as ExtensionFactory, id));
        loadedRuntimeIds.add(id);
      }),
  );

  for (const result of results) {
    if (result.status === "rejected") {
      await emitError(`Failed to load extension (${label}): ${result.reason}`);
    }
  }
}

// --- 2a. Phase A: git init + load AFPS bundle in parallel ---

const packagePath = path.join(WORKSPACE, "agent-package.afps");
const hasPackage = await exists(packagePath);

const [, bundle] = await Promise.all([
  initGitWorkspace(),
  hasPackage ? readBundleFromFile(packagePath) : Promise.resolve(null),
]);

// --- 2b. Phase B: materialise .pi/ layout + dynamic-import tools ---

if (bundle) {
  try {
    const prepared = await prepareBundleForPi(bundle, {
      workspaceDir: WORKSPACE,
      extensionWrapper: (factory, id) => wrapExtensionFactory(factory, id),
      onError: (message, err) => {
        void emitError(
          err ? `${message}: ${err instanceof Error ? err.message : String(err)}` : message,
        );
      },
    });
    extensionFactories.push(...prepared.extensionFactories);

    // Fire-and-forget cleanup of the scratch tool dir + the original AFPS;
    // they are no longer needed once the Pi SDK is up.
    void prepared.cleanup().catch(() => {});
    void fs.unlink(packagePath).catch(() => {});
  } catch (err) {
    await emitError(
      `Failed to prepare agent package: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

await loadExtensionsFromDir("/runtime/extensions", "runtime");

// --- 2c. Phase C: wire provider tools via the sidecar resolver ---
// Each `dependencies.providers[]` entry in the bundle manifest is turned
// into a typed `<provider>_call` tool (e.g. `appstrate_gmail_call`) that
// proxies through the sidecar. This replaces the legacy `curl
// $SIDECAR_URL/proxy` pattern with a structured, observable tool call
// while keeping the sidecar HTTP contract unchanged.

const sidecarUrl = process.env.SIDECAR_URL;
let providerResolver: ProviderResolver = { resolve: async () => [] };
const workspaceForProviders = WORKSPACE;

if (bundle && sidecarUrl) {
  try {
    providerResolver = new SidecarProviderResolver({
      sidecarUrl,
      providerPrefix: "providers/",
    });
    const providerFactories = await buildProviderExtensionFactories({
      bundle,
      providerResolver,
      runId: AGENT_RUN_ID,
      workspace: workspaceForProviders,
      emitProvider: (event) => {
        // Route provider lifecycle events through the same signed sink so
        // the platform observes each call structurally. Fire-and-forget —
        // HttpSink's internal retry handles transient network errors.
        void sink.handle(event);
      },
    });
    extensionFactories.push(...providerFactories);
  } catch (err) {
    await emitError(
      `Failed to wire provider tools: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// --- 3. Model + system prompt from env ---

const api = process.env.MODEL_API;
if (!api) await die("MODEL_API environment variable is required");
const modelId = process.env.MODEL_ID;
if (!modelId) await die("MODEL_ID environment variable is required");
const systemPrompt = process.env.AGENT_PROMPT;
if (!systemPrompt) await die("AGENT_PROMPT environment variable is required");

const model: Model<Api> = {
  id: modelId,
  name: modelId,
  api: api as Api,
  provider: "", // PiRunner will derive this via deriveProviderFromApi
  baseUrl: process.env.MODEL_BASE_URL || "",
  reasoning: process.env.MODEL_REASONING === "true",
  input: process.env.MODEL_INPUT
    ? (JSON.parse(process.env.MODEL_INPUT) as Array<"text" | "image">)
    : ["text"],
  cost: process.env.MODEL_COST
    ? JSON.parse(process.env.MODEL_COST)
    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: Number(process.env.MODEL_CONTEXT_WINDOW) || 128000,
  maxTokens: Number(process.env.MODEL_MAX_TOKENS) || 16384,
};

// Derive provider (matching PiRunner's table)
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
model.provider = PROVIDER_BY_API[api] ?? "";
if (!model.provider) await die(`Unknown MODEL_API: "${api}"`);

// --- 4. Build ExecutionContext from env ---

let parsedInput: Record<string, unknown> = {};
if (process.env.AGENT_INPUT) {
  try {
    parsedInput = JSON.parse(process.env.AGENT_INPUT);
  } catch {
    // Leave input empty on malformed JSON — don't silently accept
    // half-parsed input that could confuse the prompt template.
  }
}

const context: ExecutionContext = {
  runId: AGENT_RUN_ID,
  input: parsedInput,
  memories: [],
  config: {},
};

// --- 5. Resolve bundle for PiRunner (fallback to synthetic when no .afps) ---
// PiRunner needs a Bundle; when no agent-package.afps was present, the
// platform pre-installed files directly so we hand it a minimal stub
// whose content is never re-consumed.

import {
  BUNDLE_FORMAT_VERSION,
  bundleIntegrity,
  computeRecordEntries,
  recordIntegrity,
  serializeRecord,
  type Bundle,
  type PackageIdentity,
} from "@appstrate/afps-runtime/bundle";

function buildInContainerBundle(prompt: string): Bundle {
  const encoder = new TextEncoder();
  const manifestBytes = encoder.encode(
    JSON.stringify({ name: "@appstrate/in-container", version: "0.0.0", type: "agent" }),
  );
  const promptBytes = encoder.encode(prompt);
  const files = new Map<string, Uint8Array>([
    ["manifest.json", manifestBytes],
    ["prompt.md", promptBytes],
  ]);
  const recordBody = serializeRecord(computeRecordEntries(files));
  const integrity = recordIntegrity(recordBody);
  const identity = "@appstrate/in-container@0.0.0" as PackageIdentity;
  return {
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    root: identity,
    packages: new Map([
      [
        identity,
        {
          identity,
          manifest: { name: "@appstrate/in-container", version: "0.0.0", type: "agent" },
          files,
          integrity,
        },
      ],
    ]),
    integrity: bundleIntegrity(
      new Map([[identity, { path: "packages/@appstrate/in-container/0.0.0/", integrity }]]),
    ),
  };
}

const runnerBundle: Bundle = bundle ?? buildInContainerBundle(systemPrompt);

// --- 6. Run via PiRunner ---
//
// PiRunner calls `sink.finalize(result)` on both happy path and its own
// internal error path. Any error escaping it here is a bootstrap-level
// failure (before the runner reached its own try/catch) — we catch it,
// emit an error + finalize, then exit non-zero so the container monitor
// also records the crash.

const startTime = Date.now();
try {
  const runner = new PiRunner({
    model,
    apiKey: process.env.MODEL_API_KEY,
    systemPrompt,
    cwd: WORKSPACE,
    agentDir: "/tmp/pi-agent",
    extensionFactories,
    authStoragePath: "/tmp/pi-auth/auth.json",
  });

  await runner.run({
    bundle: runnerBundle,
    context,
    providerResolver,
    eventSink: sink,
  });
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await emitError(message);
  try {
    const failureResult = emptyRunResult();
    failureResult.error = { message, stack: err instanceof Error ? err.stack : undefined };
    failureResult.status = "failed";
    failureResult.durationMs = Date.now() - startTime;
    await sink.finalize(failureResult);
  } catch {
    // swallow — container exit code + server-side synthesis cover us
  }
  process.exit(1);
}
