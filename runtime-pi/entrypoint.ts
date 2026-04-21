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
import { PiRunner } from "@appstrate/runner-pi";
import type { EventSink } from "@appstrate/afps-runtime/interfaces";
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

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
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
const loadedExtensionIds = new Set<string>();

async function loadExtensionFromFile(filePath: string, id: string, label: string) {
  if (loadedExtensionIds.has(id)) return;
  const mod = await import(filePath);
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
  loadedExtensionIds.add(id);
}

async function loadExtensionsFromDir(dir: string, label: string) {
  if (!(await exists(dir))) return;
  const entries = (await fs.readdir(dir)).filter((e) => e.endsWith(".ts"));

  const results = await Promise.allSettled(
    entries
      .filter((e) => !loadedExtensionIds.has(e.replace(/\.ts$/, "")))
      .map(async (entry) => {
        const id = entry.replace(/\.ts$/, "");
        await loadExtensionFromFile(path.join(dir, entry), id, label);
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

async function loadToolsFromAgentPackage(packageDir: string, label: string) {
  const agentManifestPath = path.join(packageDir, "manifest.json");
  if (!(await exists(agentManifestPath))) return;

  let agentManifest: Record<string, unknown>;
  try {
    agentManifest = JSON.parse(await fs.readFile(agentManifestPath, "utf-8"));
  } catch {
    return;
  }

  const deps = (agentManifest.dependencies ?? {}) as Record<string, unknown>;
  const toolDeps = (deps.tools ?? {}) as Record<string, string>;
  const toolIds = Object.keys(toolDeps);

  for (const toolId of toolIds) {
    const toolPath = path.join(packageDir, "tools", toolId);
    if (!(await exists(toolPath))) continue;

    try {
      const toolManifestPath = path.join(toolPath, "manifest.json");
      if (!(await exists(toolManifestPath))) continue;
      const toolManifest = JSON.parse(await fs.readFile(toolManifestPath, "utf-8"));
      const entrypoint = toolManifest.entrypoint;
      if (!entrypoint) continue;

      const id = toolManifest.tool?.name || toolId;
      if (loadedExtensionIds.has(id)) continue;

      const toolMd = path.join(toolPath, "TOOL.md");
      if (await exists(toolMd)) {
        const dest = path.join(WORKSPACE, ".pi", "tools", toolId);
        await fs.mkdir(dest, { recursive: true });
        await fs.copyFile(toolMd, path.join(dest, "TOOL.md"));
      }

      await loadExtensionFromFile(path.join(toolPath, entrypoint), id, label);
    } catch (err) {
      emit({
        type: "appstrate.error",
        timestamp: Date.now(),
        runId: process.env.AGENT_RUN_ID ?? "unknown",
        message: `Failed to load tool '${toolId}' (${label}): ${err}`,
      });
    }
  }
}

// --- 2a. Phase A: git init + extract agent package in parallel ---

const packagePath = path.join(WORKSPACE, "agent-package.afps");
const hasPackage = await exists(packagePath);

await Promise.all([
  initGitWorkspace(),
  hasPackage
    ? run(["unzip", "-qo", packagePath, "-d", `${WORKSPACE}/.agent-package`])
    : Promise.resolve(),
]);

// --- 2b. Phase B: load tools (depends on extraction) ---

if (hasPackage) {
  try {
    const installDir = async (folder: string) => {
      const src = path.join(WORKSPACE, ".agent-package", folder);
      if (await exists(src)) {
        const dest = path.join(WORKSPACE, ".pi", folder);
        await fs.mkdir(dest, { recursive: true });
        await run(["cp", "-r", `${src}/.`, dest]);
      }
    };
    await Promise.all([installDir("skills"), installDir("providers")]);

    await loadToolsFromAgentPackage(path.join(WORKSPACE, ".agent-package"), "agent-package");

    run(["rm", "-rf", `${WORKSPACE}/.agent-package`, packagePath]).catch(() => {});
  } catch (err) {
    emit({
      type: "appstrate.error",
      timestamp: Date.now(),
      runId: process.env.AGENT_RUN_ID ?? "unknown",
      message: `Failed to process agent package: ${err}`,
    });
  }
}

await loadExtensionsFromDir("/runtime/extensions", "runtime");

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

// --- 6. Minimal bundle + noop resolvers (platform already set up files) ---

const encoder = new TextEncoder();
const bundle = {
  manifest: { name: "in-container", version: "0.0.0" } as Record<string, unknown>,
  prompt: systemPrompt,
  files: {
    "manifest.json": encoder.encode(JSON.stringify({ name: "in-container", version: "0.0.0" })),
    "prompt.md": encoder.encode(systemPrompt),
  },
  compressedSize: 0,
  decompressedSize: 0,
};

const providerResolver = { resolve: async () => [] };

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
    bundle,
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
