// SPDX-License-Identifier: Apache-2.0

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  type ExtensionFactory,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { type Model, type Api } from "@mariozechner/pi-ai";
import { wrapExtensionFactory } from "./extension-wrapper.ts";
import { emit } from "./lib/emit.ts";

// --- Helpers ---

function die(message: string): never {
  emit({ type: "error", message });
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

/**
 * Load a single extension from a file path, skipping already-loaded IDs.
 */
async function loadExtensionFromFile(filePath: string, id: string, label: string) {
  if (loadedExtensionIds.has(id)) return;
  const mod = await import(filePath);
  const factory = mod.default;
  if (typeof factory !== "function") {
    emit({
      type: "error",
      message: `Extension '${id}' (${label}): default export is not a function (got ${typeof factory})`,
    });
    return;
  }
  extensionFactories.push(wrapExtensionFactory(factory as ExtensionFactory, id));
  loadedExtensionIds.add(id);
}

/**
 * Load all .ts extension files from a flat directory, skipping already-loaded IDs.
 * Used for runtime built-in extensions fallback.
 */
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
      emit({ type: "error", message: `Failed to load extension (${label}): ${result.reason}` });
    }
  }
}

/**
 * Load tools declared in the agent manifest from the extracted agent package.
 * Reads manifest.json to get tool IDs, then loads each from tools/{toolId}/.
 * Also installs TOOL.md to .pi/tools/{toolId}/TOOL.md.
 */
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

      // Install TOOL.md if present
      const toolMd = path.join(toolPath, "TOOL.md");
      if (await exists(toolMd)) {
        const dest = path.join(WORKSPACE, ".pi", "tools", toolId);
        await fs.mkdir(dest, { recursive: true });
        await fs.copyFile(toolMd, path.join(dest, "TOOL.md"));
      }

      await loadExtensionFromFile(path.join(toolPath, entrypoint), id, label);
    } catch (err) {
      emit({ type: "error", message: `Failed to load tool '${toolId}' (${label}): ${err}` });
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
    // Install skills and provider docs in parallel
    const installDir = async (folder: string) => {
      const src = path.join(WORKSPACE, ".agent-package", folder);
      if (await exists(src)) {
        const dest = path.join(WORKSPACE, ".pi", folder);
        await fs.mkdir(dest, { recursive: true });
        await run(["cp", "-r", `${src}/.`, dest]);
      }
    };
    await Promise.all([installDir("skills"), installDir("providers")]);

    // Load agent-package tools (reads manifest to know which tools to load)
    await loadToolsFromAgentPackage(path.join(WORKSPACE, ".agent-package"), "agent-package");

    // Cleanup extracted package (fire-and-forget)
    run(["rm", "-rf", `${WORKSPACE}/.agent-package`, packagePath]).catch(() => {});
  } catch (err) {
    emit({ type: "error", message: `Failed to process agent package: ${err}` });
  }
}

// Load runtime built-in extensions (skip any already loaded from agent package)
await loadExtensionsFromDir("/runtime/extensions", "runtime");

// --- 3. Setup auth + model ---

function deriveProviderFromApi(api: string): string {
  const known: Record<string, string> = {
    "anthropic-messages": "anthropic",
    "openai-completions": "openai",
    "openai-responses": "openai",
    "mistral-conversations": "mistral",
    "google-generative-ai": "google",
    "google-vertex": "google-vertex",
    "azure-openai-responses": "azure-openai-responses",
    "bedrock-converse-stream": "amazon-bedrock",
  };
  const provider = known[api];
  if (!provider) throw new Error(`Unknown MODEL_API: "${api}"`);
  return provider;
}

const api = process.env.MODEL_API;
if (!api) die("MODEL_API environment variable is required");
const modelId = process.env.MODEL_ID;
if (!modelId) die("MODEL_ID environment variable is required");
const provider = deriveProviderFromApi(api);

const authStorage = new AuthStorage("/tmp/pi-auth/auth.json");

// Store generic LLM API key for the active provider
const llmApiKey = process.env.MODEL_API_KEY;
if (llmApiKey) {
  authStorage.setRuntimeApiKey(provider, llmApiKey);
}

const modelRegistry = new ModelRegistry(authStorage);

const model: Model<Api> = {
  id: modelId,
  name: modelId,
  api,
  provider,
  baseUrl: process.env.MODEL_BASE_URL || "",
  reasoning: process.env.MODEL_REASONING === "true",
  input: process.env.MODEL_INPUT ? (JSON.parse(process.env.MODEL_INPUT) as string[]) : ["text"],
  cost: process.env.MODEL_COST
    ? JSON.parse(process.env.MODEL_COST)
    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: Number(process.env.MODEL_CONTEXT_WINDOW) || 128000,
  maxTokens: Number(process.env.MODEL_MAX_TOKENS) || 16384,
};

// --- 4. Build resource loader ---

const systemPrompt = process.env.AGENT_PROMPT;
if (!systemPrompt) {
  die("AGENT_PROMPT environment variable is required");
}

const resourceLoader = new DefaultResourceLoader({
  cwd: WORKSPACE,
  agentDir: "/tmp/pi-agent",
  settingsManager: SettingsManager.inMemory(),
  extensionFactories,
  noExtensions: extensionFactories.length === 0, // skip discovery if no extensions
  noPromptTemplates: true, // we don't use prompt templates
  noThemes: true, // no themes needed in headless mode
  systemPrompt,
});
await resourceLoader.reload();

// --- 5. Create agent session ---

try {
  const { session } = await createAgentSession({
    cwd: WORKSPACE,
    agentDir: "/tmp/pi-agent",
    model,
    thinkingLevel: "medium",
    authStorage,
    modelRegistry,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    }),
  });

  // --- 6. Subscribe to events → emit JSON lines ---

  // Token usage accumulator across all assistant turns
  const totalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

  session.subscribe((event) => {
    switch (event.type) {
      case "message_update": {
        const msgEvent = (event as any).assistantMessageEvent;
        if (msgEvent?.type === "text_delta" && msgEvent.delta) {
          emit({ type: "text_delta", text: msgEvent.delta });
        }
        break;
      }

      case "message_end": {
        // Capture the full assistant message text
        const entries = session.state.messages;
        if (entries.length) {
          const last = entries[entries.length - 1];
          if (last && (last as any).role === "assistant") {
            // Accumulate token usage from assistant message
            const u = (last as any).usage;
            if (u) {
              totalUsage.input += u.input ?? 0;
              totalUsage.output += u.output ?? 0;
              totalUsage.cacheRead += u.cacheRead ?? 0;
              totalUsage.cacheWrite += u.cacheWrite ?? 0;
              totalUsage.cost += u.cost?.total ?? 0;
            }

            // Emit SDK errors (e.g. LLM API unreachable, auth failures)
            if ((last as any).stopReason === "error" && (last as any).errorMessage) {
              emit({ type: "error", message: (last as any).errorMessage });
            }

            const content = (last as any).content;
            if (Array.isArray(content)) {
              const text = content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text || "")
                .join("\n");
              if (text) {
                emit({ type: "assistant_message", text });
              }
            }
          }
        }
        break;
      }

      case "tool_execution_start": {
        const e = event as any;
        emit({ type: "tool_start", name: e.toolName || "unknown", args: e.args });
        break;
      }

      case "tool_execution_end": {
        const e = event as any;
        emit({ type: "tool_end", name: e.toolName || "unknown" });
        break;
      }

      case "agent_end": {
        // Emit accumulated token usage before agent_end
        emit({
          type: "usage",
          tokens: {
            input: totalUsage.input,
            output: totalUsage.output,
            cacheRead: totalUsage.cacheRead,
            cacheWrite: totalUsage.cacheWrite,
          },
          cost: totalUsage.cost,
        });
        emit({ type: "agent_end" });
        break;
      }

      default:
        break;
    }
  });

  // --- 7. Run the prompt ---

  try {
    await session.prompt(systemPrompt);
  } catch (promptErr) {
    emit({
      type: "error",
      message: promptErr instanceof Error ? promptErr.message : String(promptErr),
    });
    process.exit(1);
  }

  process.exit(0);
} catch (err) {
  emit({
    type: "error",
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
}
