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
 * Configuration / Checkpoint / Memory / Run History) represent one
 * reasonable convention for an AFPS-style agent; platforms and CLIs
 * may compose it as-is or override specific option fields.
 */

import type { ExecutionContext } from "../types/execution-context.ts";
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

export type PlatformPromptProvider = PromptViewProvider;

export interface PlatformPromptSchema {
  properties?: Record<string, unknown>;
  required?: readonly string[];
}

export interface PlatformPromptOptions {
  /** Raw prompt template from the bundle's root package (`prompt.md`). */
  template: string;
  /** Run context — flows into the 1.1+ template render + checkpoint/memory sections. */
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
   * The LLM-facing tool surface is the canonical `provider_call`;
   * each entry contributes one `providerId` to that tool's enum.
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
      "Authenticated requests to connected providers go through the `provider_call` MCP tool " +
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
      "To call any connected provider, use the `provider_call` MCP tool with " +
        "`{ providerId, method, target, headers?, body?, responseMode? }`. " +
        "Pass the `providerId` from the list below; `target` must be an absolute URL " +
        "matching one of the provider's authorized URLs. " +
        "Non-2xx upstream responses are returned with `isError: true` — read the body to " +
        "diagnose rather than retrying blindly. Proxy timeout is 30 s. " +
        "For other public APIs (no auth), call them directly with `curl` / `fetch`.\n",
    );

    sections.push(
      'Binary content: pass `body: { fromFile: "documents/<name>" }` to upload a workspace file as the request body, or `body: { fromBytes: "<base64>", encoding: "base64" }` to upload inline binary bytes computed in memory (up to 5 MB; standard base64 RFC 4648 §4 only — alphabet `+/`; URL-safe base64 with `-_` is not accepted). ' +
        'Use `responseMode: { toFile: "documents/<name>.<ext>" }` to stream the upstream response into the workspace. ' +
        'Without `toFile`, responses larger than 64 KB auto-spill to a file under `responses/<toolCallId>.bin`; smaller binaries are returned base64-encoded under `body.data` with `body.kind === "inline"`. ' +
        "Inspect `body.kind` on the returned JSON to dispatch.\n",
    );

    sections.push(
      "Multipart uploads (e.g. Drive file upload, Gmail send with attachment): pass `body: { multipart: [...] }` to compose a multipart/form-data body mixing text fields and workspace files. " +
        'Each part is one of: `{ name, value }` (text field), `{ name, fromFile, filename?, contentType? }` (workspace file), or `{ name, fromBytes, encoding: "base64", filename?, contentType? }` (inline bytes). ' +
        'Example — Drive resumable upload metadata + file: `{ multipart: [{ name: "metadata", value: JSON.stringify({name:"report.pdf"}), contentType: "application/json" }, { name: "file", fromFile: "documents/report.pdf", contentType: "application/pdf" }] }`. ' +
        'Example — Gmail send with inline attachment: `{ multipart: [{ name: "message", value: rawMimeString }, { name: "attachment", fromFile: "documents/invoice.pdf", filename: "invoice.pdf", contentType: "application/pdf" }] }`. ' +
        "Total size across all parts is capped at 5 MB; use a single `{ fromFile }` body for larger uploads.\n",
    );

    sections.push("Available providers:");
    sections.push(
      "Each provider has a corresponding skill (`provider-<scope>-<name>`) — read it before calling `provider_call` for the first time. Skills are listed under `<available_skills>` with full descriptions and file paths.\n",
    );
    for (const provider of connectedProviders) {
      const displayName = provider.displayName ?? provider.id;

      sections.push(`- **${displayName}** (\`${provider.id}\`)`);

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

  // --- Checkpoint ---
  if (context.checkpoint !== undefined && context.checkpoint !== null) {
    sections.push("## Checkpoint\n");
    sections.push(
      "This agent supports stateful operation across runs. " +
        "Your most recent run left the following checkpoint:\n",
    );
    sections.push("```json");
    sections.push(JSON.stringify(context.checkpoint, null, 2));
    sections.push("```\n");
    sections.push(
      "Use this checkpoint to resume work, avoid reprocessing data, or build on previous results. " +
        'To update the checkpoint for the next run, call `pin({ key: "checkpoint", content: ... })`. ' +
        "By default checkpoints are scoped to the run's actor (the user or end-user that triggered the run); " +
        'pass `scope: "shared"` for an app-wide checkpoint visible to every actor.\n',
    );
  }

  // --- Memory ---
  // Two tiers (ADR-012, ADR-013):
  //   - Pinned memories (rendered here)  → working set, always visible.
  //   - Archive memories (NOT rendered) → reachable via `recall_memory`.
  // We always emit the section so the agent knows the archive exists,
  // even when no memories are pinned yet.
  sections.push("## Memory\n");
  if (context.memories && context.memories.length > 0) {
    sections.push("Pinned memories (always visible across runs):\n");
    for (const mem of context.memories) {
      const date = mem.createdAt ? ` (${new Date(mem.createdAt).toISOString()})` : "";
      sections.push(`- ${mem.content}${date}`);
    }
    sections.push("");
  } else {
    sections.push("No memories are currently pinned to this prompt.\n");
  }
  sections.push(
    "To save a new archive memory, call `note({ content })` — it goes to the **archive** " +
      "(not visible in this prompt on future runs). " +
      "To search the archive, call `recall_memory({ q?, limit? })`: pass `q` to filter by " +
      "case-insensitive substring, omit it for the most recent entries. " +
      'By default notes are scoped to the current actor; pass `scope: "shared"` on `note` ' +
      "to make it app-wide. Use `pin({ key, content })` to upsert a pinned slot rendered " +
      'into this prompt on every run — `key: "checkpoint"` for the carry-over checkpoint, ' +
      'or any other key (e.g. "persona", "goals") for additional pinned blocks.\n',
  );

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
    checkpoint: context.checkpoint ?? null,
    memories: context.memories ?? [],
    history: context.history ?? [],
  };
}
