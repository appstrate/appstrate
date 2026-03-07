import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  type ExtensionFactory,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { wrapExtensionFactory } from "./extension-wrapper.ts";

// --- Helpers ---

function emit(obj: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function die(message: string): never {
  emit({ type: "error", message });
  process.exit(1);
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);

/** Unwrap the default export from a dynamically imported module.
 *  Some bundlers double-wrap: mod.default may be a module namespace
 *  whose own .default holds the actual function. Walk up to 2 levels. */
function resolveDefaultExport(mod: Record<string, unknown>): unknown {
  let value = mod.default;
  if (typeof value !== "function" && value && typeof (value as any).default !== "undefined") {
    value = (value as any).default;
  }
  return value;
}

// --- 1. Init workspace ---

const WORKSPACE = "/workspace";
try {
  await run(["git", "init", "-q", WORKSPACE]);
  await Promise.all([
    run(["git", "-C", WORKSPACE, "config", "user.email", "pi@appstrate.local"]),
    run(["git", "-C", WORKSPACE, "config", "user.name", "Pi"]),
  ]);
} catch {
  // Non-fatal — git init may fail if already initialized
}

// --- 2. Load extensions ---

const extensionFactories: ExtensionFactory[] = [];
const loadedExtensionIds = new Set<string>();

/**
 * Load all .ts extension files from a directory, skipping already-loaded IDs.
 * Uses native import() — Bun handles TypeScript natively without tsx.
 */
async function loadExtensionsFromDir(dir: string, label: string) {
  if (!(await exists(dir))) return;
  for (const entry of await fs.readdir(dir)) {
    if (!entry.endsWith(".ts")) continue;
    const id = entry.replace(/\.ts$/, "");
    if (loadedExtensionIds.has(id)) continue;
    const extPath = path.join(dir, entry);
    try {
      const mod = await import(extPath);
      const factory = resolveDefaultExport(mod);
      if (typeof factory !== "function") {
        emit({ type: "error", message: `Extension '${entry}' (${label}): default export is not a function (got ${typeof factory})` });
        continue;
      }
      extensionFactories.push(wrapExtensionFactory(factory as ExtensionFactory, id));
      loadedExtensionIds.add(id);
      emit({ type: "text_delta", text: `Loaded extension (${label}): ${entry}\n` });
    } catch (err) {
      emit({ type: "error", message: `Failed to load extension '${entry}' (${label}): ${err}` });
    }
  }
}

// --- 2a. Extract flow package if present ---

const packagePath = path.join(WORKSPACE, "flow-package.zip");

if (await exists(packagePath)) {
  try {
    await run(["unzip", "-qo", packagePath, "-d", `${WORKSPACE}/.flow-package`]);

    // Install skills
    const skillsDir = path.join(WORKSPACE, ".flow-package", "skills");
    if (await exists(skillsDir)) {
      const piSkillsDir = path.join(WORKSPACE, ".pi", "skills");
      await fs.mkdir(piSkillsDir, { recursive: true });
      await run(["cp", "-r", `${skillsDir}/.`, piSkillsDir]);
      emit({ type: "text_delta", text: "Installed skills from flow package\n" });
    }

    // Ensure node_modules resolution works for dynamically imported extensions
    const workspaceNodeModules = path.join(WORKSPACE, "node_modules");
    if (!(await exists(workspaceNodeModules))) {
      try {
        await fs.symlink("/runtime/node_modules", workspaceNodeModules);
      } catch {
        // Non-fatal — Bun resolves from parent dirs too
      }
    }

    // Load flow-package extensions first (they take priority over runtime built-ins)
    await loadExtensionsFromDir(path.join(WORKSPACE, ".flow-package", "extensions"), "flow-package");

    // Cleanup extracted package
    await run(["rm", "-rf", `${WORKSPACE}/.flow-package`, packagePath]);
  } catch (err) {
    emit({ type: "error", message: `Failed to extract flow package: ${err}` });
  }
}

// --- 2b. Load runtime built-in extensions (skip any already loaded from flow package) ---

await loadExtensionsFromDir("/runtime/extensions", "runtime");

// --- 3. Setup auth + model ---

const provider = process.env.LLM_PROVIDER || "anthropic";
const modelId = process.env.LLM_MODEL_ID || "claude-sonnet-4-5-20250929";

const authStorage = new AuthStorage("/tmp/pi-auth/auth.json");

// Map provider env vars to auth storage
const providerKeyMap: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  together: "TOGETHER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

for (const [provName, envVar] of Object.entries(providerKeyMap)) {
  if (process.env[envVar]) {
    authStorage.setRuntimeApiKey(provName, process.env[envVar]!);
  }
}

const modelRegistry = new ModelRegistry(authStorage);

const model = getModel(provider, modelId);
if (!model) {
  die(`Model not found: ${provider}/${modelId}`);
}

// --- 4. Build resource loader ---

const systemPrompt = process.env.FLOW_PROMPT;
if (!systemPrompt) {
  die("FLOW_PROMPT environment variable is required");
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
        if (entries.length > 0) {
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
