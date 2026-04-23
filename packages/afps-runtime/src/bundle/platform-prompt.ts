// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Composes the platform-level system prompt preamble that wraps a
 * bundle's `prompt.md` template before it reaches the LLM.
 *
 * This is NOT an AFPS contract — callers choose whether to prepend it.
 * External runners happy with the raw template alone (`renderPrompt`)
 * can skip this helper. The sections it builds (System / Environment /
 * Tools / Skills / Connected Providers / User Input / Documents /
 * Configuration / Previous State / Memory / Run History) represent one
 * reasonable convention for an AFPS-style agent; platforms and CLIs
 * may compose it as-is or override specific option fields.
 */

import type { ExecutionContext } from "../types/execution-context.ts";
import { providerToolName } from "../resolvers/index.ts";
import { renderTemplate } from "../template/mustache.ts";
import type { PromptView, PromptViewProvider, PromptViewUpload } from "./prompt-renderer.ts";

const TEMPLATE_RENDER_MIN_VERSION = [1, 1] as const;

function supportsTemplateRendering(schemaVersion: string | undefined): boolean {
  if (!schemaVersion) return false;
  const match = /^(\d+)\.(\d+)/.exec(schemaVersion);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const [minMajor, minMinor] = TEMPLATE_RENDER_MIN_VERSION;
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

/**
 * Heuristic matching the AFPS 1.3 file-field convention: a JSON Schema
 * node is a "file" when it is a string with `format: uri` and a
 * `contentMediaType`, or an array of such items.
 */
function isFileField(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const s = schema as Record<string, unknown>;
  if (s.type === "string" && s.format === "uri" && typeof s.contentMediaType === "string") {
    return true;
  }
  if (s.type === "array" && typeof s.items === "object" && s.items !== null) {
    return isFileField(s.items);
  }
  return false;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export interface PlatformPromptTool {
  id: string;
  name?: string;
  description?: string;
}

export interface PlatformPromptProvider extends PromptViewProvider {
  /** Tool name the provider exposes (defaults to `providerToolName(id)`). */
  toolName?: string;
  /** When true, a per-provider `PROVIDER.md` ships in the workspace skills tree. */
  hasProviderDoc?: boolean;
}

export interface PlatformPromptSchema {
  properties?: Record<string, unknown>;
  required?: readonly string[];
}

export interface PlatformPromptOptions {
  /** Raw prompt template from the bundle's root package (`prompt.md`). */
  template: string;
  /** Run context — flows into the 1.1+ template render + state/memory sections. */
  context: ExecutionContext;
  /** Manifest schemaVersion — gates Mustache render path selection. */
  schemaVersion?: string;

  /** Display name of the running platform. Default: `"Appstrate"`. */
  platformName?: string;
  /** Run timeout in seconds — surfaced in the `## System` section. */
  timeoutSeconds?: number;

  /** Bundled tools catalogue + inline TOOL.md docs. */
  availableTools?: ReadonlyArray<PlatformPromptTool>;
  /** Bundled skills catalogue. */
  availableSkills?: ReadonlyArray<PlatformPromptTool>;
  /** Raw TOOL.md contents appended after the tool list. */
  toolDocs?: ReadonlyArray<{ id: string; content: string }>;

  /**
   * Providers to surface in the `## Connected Providers` section.
   * Caller-filtered — pass only those for which credentials are wired.
   * `toolName` defaults to `providerToolName(id)` when absent.
   */
  providers?: ReadonlyArray<PlatformPromptProvider>;

  /** Input schema — drives the `## User Input` section. */
  inputSchema?: PlatformPromptSchema;
  /** Config schema — drives the `## Configuration` section. */
  configSchema?: PlatformPromptSchema;
  /**
   * Output schema — drives the `## Output Format` section. The full JSON
   * Schema (as it appears under `manifest.output.schema`) is surfaced in
   * plain text so the LLM sees the constraint in the prompt AND via the
   * `output` tool definition. This belt-and-suspenders is necessary
   * because pi-ai currently sends `strict: false` on tool schemas — the
   * LLM treats tool `required` as a hint, not a decode constraint, so
   * weaker models routinely call `output({})` before the correct shape.
   */
  outputSchema?: Record<string, unknown>;

  /** Uploaded documents surfaced in `## Documents`. */
  uploads?: ReadonlyArray<PromptViewUpload>;

  /**
   * When true, emit the `## Run History` section referencing the
   * sidecar's `/run-history` endpoint via `$SIDECAR_URL`. Platforms
   * without a sidecar should leave this unset.
   */
  runHistoryApi?: boolean;

  /** Optional pre-built PromptView; skip if you want to let the helper build one. */
  promptView?: PromptView;
}

export function renderPlatformPrompt(opts: PlatformPromptOptions): string {
  const sections: string[] = [];
  const { context } = opts;
  const input = (context.input as Record<string, unknown>) ?? {};
  const config = context.config ?? {};
  const platformName = opts.platformName ?? "Appstrate";
  const connectedProviders = opts.providers ?? [];

  // --- System identity & environment ---
  sections.push("## System\n");
  sections.push(`You are an AI agent running on the ${platformName} platform.`);
  sections.push("You execute a specific task inside an isolated, ephemeral container.\n");

  sections.push("### Environment");
  sections.push(
    "- **Ephemeral container**: This container is destroyed when your run ends. " +
      "Any files you create, modifications you make, or data you store on the filesystem will be permanently lost. " +
      "Do NOT rely on the filesystem for persistence.",
  );
  sections.push(
    "- **Network access**: Outbound HTTP/HTTPS is available. " +
      "Use `curl`, `fetch`, or any HTTP client to call public APIs and websites directly. " +
      "Authenticated requests to connected providers go through the `<provider>_call` tools " +
      "listed under **Connected Providers** — credentials are injected server-side.",
  );
  if (opts.timeoutSeconds) {
    sections.push(
      `- **Timeout**: You have ${opts.timeoutSeconds} seconds to complete this task. ` +
        "Work efficiently and output your result promptly.",
    );
  }
  sections.push(
    "- **Workspace**: Your current working directory is the agent workspace. " +
      "Uploaded documents are available under `./documents/` (relative to cwd). " +
      "You may use the filesystem for temporary processing during this run only.\n",
  );

  if (opts.availableTools && opts.availableTools.length > 0) {
    sections.push("### Tools");
    sections.push(
      "You have access to the following tools (in addition to standard coding capabilities):\n",
    );
    for (const tool of opts.availableTools) {
      const desc = tool.description ? `: ${tool.description}` : "";
      sections.push(`- **${tool.name || tool.id}**${desc}`);
    }
    sections.push("");
  }

  if (opts.toolDocs && opts.toolDocs.length > 0) {
    for (const doc of opts.toolDocs) {
      sections.push(doc.content);
      sections.push("");
    }
  }

  if (opts.availableSkills && opts.availableSkills.length > 0) {
    sections.push("### Skills");
    sections.push(
      "The following skill references are available in your workspace at `.pi/skills/`:\n",
    );
    for (const skill of opts.availableSkills) {
      const desc = skill.description ? `: ${skill.description}` : "";
      sections.push(`- **${skill.name || skill.id}**${desc}`);
    }
    sections.push("");
  }

  // --- Connected providers ---
  if (connectedProviders.length > 0) {
    sections.push("## Connected Providers\n");
    sections.push(
      "Use the tool listed next to each provider to make authenticated calls. " +
        "Pass `method`, `target` (absolute URL — must match the provider's authorized URLs), " +
        "and optional `headers` / `body`. Non-2xx upstream responses are returned with `isError: true` — " +
        "read the body to diagnose rather than retrying blindly. Proxy timeout is 30 s. " +
        "For other public APIs (no auth), call them directly with `curl` / `fetch`.\n",
    );

    for (const provider of connectedProviders) {
      const displayName = provider.displayName ?? provider.id;
      const toolName = provider.toolName ?? providerToolName(provider.id);

      sections.push(`- **${displayName}** (\`${provider.id}\`) → \`${toolName}\``);

      if (provider.hasProviderDoc) {
        sections.push(`  API docs: \`.pi/providers/${provider.id}/PROVIDER.md\``);
      } else if (provider.docsUrl) {
        sections.push(`  Documentation: ${provider.docsUrl}`);
      }

      if (provider.allowAllUris) {
        sections.push(`  Authorized URLs: all public URLs`);
      } else if (provider.authorizedUris && provider.authorizedUris.length > 0) {
        sections.push(`  Authorized URLs: ${provider.authorizedUris.join(", ")}`);
      }
    }
    sections.push("");
  }

  // --- User input ---
  const inputProps = opts.inputSchema?.properties;
  const inputRequired = opts.inputSchema?.required ?? [];
  const nonFileInputEntries = Object.entries(input).filter(([key]) => {
    const prop = inputProps?.[key];
    return prop ? !isFileField(prop) : true;
  });

  if (nonFileInputEntries.length > 0 || (inputProps && Object.keys(inputProps).length > 0)) {
    sections.push("## User Input\n");
    if (inputProps) {
      for (const [key, prop] of Object.entries(inputProps)) {
        if (isFileField(prop)) continue;
        const req = inputRequired.includes(key) ? "required" : "optional";
        const value = input[key];
        const valueStr = value !== undefined ? ` — \`${String(value)}\`` : "";
        const propRec = (prop as Record<string, unknown>) ?? {};
        const type = propRec.type;
        const description = typeof propRec.description === "string" ? propRec.description : "";
        sections.push(
          `- **${key}** (${String(type ?? "unknown")}, ${req}): ${description}${valueStr}`,
        );
      }
    } else {
      for (const [key, value] of nonFileInputEntries) {
        sections.push(`- **${key}**: ${String(value)}`);
      }
    }
    sections.push("");
  }

  // --- Uploaded documents ---
  if (opts.uploads && opts.uploads.length > 0) {
    sections.push("## Documents\n");
    sections.push(
      "The following documents have been uploaded and are available on the local filesystem:\n",
    );
    for (const file of opts.uploads) {
      sections.push(
        `- **${file.name}** (${file.type || "unknown"}, ${formatFileSize(file.size)}) → \`${file.path}\``,
      );
    }
    sections.push(
      "\nRead the documents directly from the filesystem (paths are relative to cwd).\n",
    );
  }

  // --- Configuration ---
  const configProps = opts.configSchema?.properties;
  const configRequired = opts.configSchema?.required ?? [];
  const configEntries = Object.entries(config);

  if (configEntries.length > 0 || (configProps && Object.keys(configProps).length > 0)) {
    sections.push("## Configuration\n");
    if (configProps) {
      for (const [key, prop] of Object.entries(configProps)) {
        const req = configRequired.includes(key) ? "required" : "optional";
        const value = config[key];
        const valueStr = value !== undefined ? ` — \`${String(value)}\`` : "";
        const propRec = (prop as Record<string, unknown>) ?? {};
        const type = propRec.type;
        const description = typeof propRec.description === "string" ? propRec.description : "";
        sections.push(
          `- **${key}** (${String(type ?? "unknown")}, ${req}): ${description}${valueStr}`,
        );
      }
    } else {
      for (const [key, value] of configEntries) {
        sections.push(`- **${key}**: ${String(value)}`);
      }
    }
    sections.push("");
  }

  // --- Previous state ---
  if (context.state !== undefined && context.state !== null) {
    sections.push("## Previous State\n");
    sections.push(
      "This agent supports stateful operation across runs. " +
        "Your most recent run left the following state:\n",
    );
    sections.push("```json");
    sections.push(JSON.stringify(context.state, null, 2));
    sections.push("```\n");
    sections.push(
      "Use this state to resume work, avoid reprocessing data, or build on previous results. " +
        "To update the state for the next run, use the `set_state` tool.\n",
    );
  }

  // --- Memory ---
  if (context.memories && context.memories.length > 0) {
    sections.push("## Memory\n");
    sections.push(
      "This agent has accumulated the following memories from previous runs. " +
        "These are shared across all users running this agent:\n",
    );
    for (const mem of context.memories) {
      const date = mem.createdAt ? ` (${new Date(mem.createdAt).toISOString()})` : "";
      sections.push(`- ${mem.content}${date}`);
    }
    sections.push(
      "\nTo add new memories, use the `add_memory` tool. " +
        "Use memories for discoveries, learnings, and insights worth remembering long-term. " +
        "Use `set_state` for structured data needed for the next run.\n",
    );
  }

  // --- Run History API ---
  if (opts.runHistoryApi) {
    sections.push("## Run History\n");
    sections.push(
      "You can access data from previous runs beyond just the latest state. " +
        "This is useful for trend analysis, auditing past runs, or recovering from failures.\n",
    );
    sections.push("```bash");
    sections.push('curl -s "$SIDECAR_URL/run-history?limit=10&fields=state"');
    sections.push("```\n");
    sections.push("Query parameters:");
    sections.push("- `limit` (1-50, default 10): Number of past runs to return");
    sections.push(
      "- `fields` (comma-separated: `state`, `result`; default: `state`): Which data fields to include\n",
    );
    sections.push("Returns `{ runs: [{ id, status, date, duration, ...selected_fields }] }`\n");
  }

  // --- Output format ---
  // Rendered LAST so the constraint is freshly in the LLM's context when
  // it reads the agent task prompt below. See `outputSchema` docstring
  // for why this duplicates the tool-level schema.
  if (opts.outputSchema && Object.keys(opts.outputSchema).length > 0) {
    sections.push("## Output Format\n");
    sections.push(
      "You MUST call the `output` tool **exactly once** before finishing, " +
        "with a `data` parameter that satisfies the JSON Schema below. " +
        "Provide ALL required fields in that single call — do not probe " +
        "with `output({})` first, and do not split the payload across " +
        "multiple calls (each call REPLACES the previous one).\n",
    );

    const required = Array.isArray(opts.outputSchema.required)
      ? (opts.outputSchema.required as readonly unknown[]).filter(
          (v): v is string => typeof v === "string",
        )
      : [];
    const props = opts.outputSchema.properties;
    if (props && typeof props === "object" && !Array.isArray(props)) {
      sections.push("### Required shape\n");
      for (const [key, prop] of Object.entries(props as Record<string, unknown>)) {
        const propRec = (prop as Record<string, unknown>) ?? {};
        const type = propRec.type;
        const req = required.includes(key) ? "required" : "optional";
        const description =
          typeof propRec.description === "string" ? `: ${propRec.description}` : "";
        sections.push(`- **${key}** (${String(type ?? "unknown")}, ${req})${description}`);
      }
      sections.push("");
    }

    sections.push("### Full JSON Schema\n");
    sections.push("```json");
    sections.push(JSON.stringify(opts.outputSchema, null, 2));
    sections.push("```\n");
  }

  // schemaVersion 1.1+: render rawPrompt through logic-less Mustache so
  // templates can reference `{{runId}}`, `{{input.*}}`, `{{#memories}}…`,
  // etc. Legacy 1.0 bundles keep verbatim append — unchanged output.
  const finalRawPrompt = supportsTemplateRendering(opts.schemaVersion)
    ? renderTemplate(opts.template, buildTemplateView(context))
    : opts.template;

  return sections.join("\n") + "\n---\n\n" + finalRawPrompt;
}

function buildTemplateView(context: ExecutionContext): PromptView {
  return {
    runId: context.runId,
    input: (context.input as Record<string, unknown>) ?? {},
    config: context.config ?? {},
    state: context.state ?? null,
    memories: context.memories ?? [],
    history: context.history ?? [],
  };
}
