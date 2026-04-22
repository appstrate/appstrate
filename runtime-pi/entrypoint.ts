// SPDX-License-Identifier: Apache-2.0

/**
 * runtime-pi entrypoint — thin bootloader that wires the agent container
 * runtime into the shared {@link PiRunner}. The same `PiRunner` used
 * here is what external consumers instantiate against their own
 * {@link EventSink}; structural parity between in-container and out-of-
 * container execution is guaranteed by using the same class.
 *
 * Responsibilities (runtime-pi only):
 *   1. Extract the injected agent package (if any) into the workspace.
 *   2. Initialise a git repo for the Pi coding tools.
 *   3. Install TOOL.md / skills / providers into `.pi/` for on-disk lookup.
 *   4. Collect tool extension factories (from agent package + built-ins).
 *   5. Build an {@link ExecutionContext} from env vars.
 *   6. Build a stdout JSONL {@link EventSink} — the current agent ↔ platform
 *      wire protocol.
 *   7. Instantiate {@link PiRunner} and `await runner.run(...)`.
 *
 * The event-to-RunEvent translation that used to live in this file is
 * now inside {@link PiRunner}. The platform side (`apps/api`) no longer
 * needs `parsePiStreamLine` — events arriving over stdout are already
 * canonical AFPS {@link RunEvent}s.
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
import type { EventSink } from "@appstrate/afps-runtime/interfaces";
import { SidecarProviderResolver, type ProviderResolver } from "@appstrate/afps-runtime/resolvers";
import type { ExecutionContext, RunEvent } from "@appstrate/afps-runtime/types";
import type { RunResult } from "@appstrate/afps-runtime/runner";
import { wrapExtensionFactory } from "./extension-wrapper.ts";
import { emit } from "./lib/emit.ts";

// --- Helpers ---

function die(message: string): never {
  emit({
    type: "appstrate.error",
    timestamp: Date.now(),
    runId: process.env.AGENT_RUN_ID ?? "unknown",
    message,
  });
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
          emit({
            type: "appstrate.error",
            timestamp: Date.now(),
            runId: process.env.AGENT_RUN_ID ?? "unknown",
            message: `Extension '${id}' (${label}): default export is not a function (got ${typeof factory})`,
          });
          return;
        }
        extensionFactories.push(wrapExtensionFactory(factory as ExtensionFactory, id));
        loadedRuntimeIds.add(id);
      }),
  );

  for (const result of results) {
    if (result.status === "rejected") {
      emit({
        type: "appstrate.error",
        timestamp: Date.now(),
        runId: process.env.AGENT_RUN_ID ?? "unknown",
        message: `Failed to load extension (${label}): ${result.reason}`,
      });
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
        emit({
          type: "appstrate.error",
          timestamp: Date.now(),
          runId: process.env.AGENT_RUN_ID ?? "unknown",
          message: err
            ? `${message}: ${err instanceof Error ? err.message : String(err)}`
            : message,
        });
      },
    });
    extensionFactories.push(...prepared.extensionFactories);

    // Fire-and-forget cleanup of the scratch tool dir + the original AFPS;
    // they are no longer needed once the Pi SDK is up.
    void prepared.cleanup().catch(() => {});
    void fs.unlink(packagePath).catch(() => {});
  } catch (err) {
    emit({
      type: "appstrate.error",
      timestamp: Date.now(),
      runId: process.env.AGENT_RUN_ID ?? "unknown",
      message: `Failed to prepare agent package: ${err instanceof Error ? err.message : String(err)}`,
    });
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
const runIdEarly = process.env.AGENT_RUN_ID ?? "local_run";
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
      runId: runIdEarly,
      workspace: workspaceForProviders,
      emitProvider: (event) => {
        // Route provider lifecycle events into the stdout JSONL stream
        // so the platform observes each call structurally.
        emit(event as Record<string, unknown>);
      },
    });
    extensionFactories.push(...providerFactories);
  } catch (err) {
    emit({
      type: "appstrate.error",
      timestamp: Date.now(),
      runId: runIdEarly,
      message: `Failed to wire provider tools: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

// --- 3. Model + system prompt from env ---

const api = process.env.MODEL_API;
if (!api) die("MODEL_API environment variable is required");
const modelId = process.env.MODEL_ID;
if (!modelId) die("MODEL_ID environment variable is required");
const systemPrompt = process.env.AGENT_PROMPT;
if (!systemPrompt) die("AGENT_PROMPT environment variable is required");

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
if (!model.provider) die(`Unknown MODEL_API: "${api}"`);

// --- 4. Build ExecutionContext from env ---

const runId = process.env.AGENT_RUN_ID ?? "local_run";

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
  runId,
  input: parsedInput,
  memories: [],
  config: {},
};

// --- 5. Stdout JSONL sink ---

const stdoutSink: EventSink = {
  async handle(event: RunEvent): Promise<void> {
    emit(event as unknown as Record<string, unknown>);
  },
  async finalize(_result: RunResult): Promise<void> {
    // The platform reads stdout events and runs its own reducer; no
    // extra wire message needed. Kept as a no-op hook for parity with
    // out-of-container runners that may emit a terminal summary.
  },
};

// --- 6. Resolve bundle for PiRunner (fallback to synthetic when no .afps) ---
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

// --- 7. Run via PiRunner ---

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
    eventSink: stdoutSink,
  });
  process.exit(0);
} catch (err) {
  emit({
    type: "appstrate.error",
    timestamp: Date.now(),
    runId,
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
}
