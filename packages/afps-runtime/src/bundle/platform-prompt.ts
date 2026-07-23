// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Composes the platform-level system prompt preamble that wraps a
 * bundle's `prompt.md` template before it reaches the LLM.
 *
 * This is NOT an AFPS contract — callers choose whether to prepend it.
 * External runners happy with the raw template alone (`renderPrompt`)
 * can skip this helper. The sections it builds (System / Environment /
 * Tools / Skills / User Input / Documents / Configuration / Checkpoint /
 * Memory / Run History) represent one reasonable convention for an
 * AFPS-style agent; platforms and CLIs may compose it as-is or override
 * specific option fields.
 */

import type { ExecutionContext } from "../types/execution-context.ts";
import { isFileField } from "@appstrate/afps-shared/file-field";
import type { PromptView, PromptViewUpload } from "./prompt-renderer.ts";

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

/**
 * Per-integration prompt entry. The integration is identified by its
 * package id; the optional human-readable description comes from the
 * integration manifest, and `doc` carries the raw `INTEGRATION.md`
 * content (AFPS §3.5) — when present, the runtime SHOULD surface it
 * to the agent. We inline it directly into the platform prompt so the
 * LLM can read it without an extra workspace lookup.
 */
export interface PlatformPromptIntegration {
  id: string;
  description?: string;
  /**
   * Raw `INTEGRATION.md` content (markdown). When non-empty, renders a
   * `### API Documentation` subsection under the integration's section.
   * Caller-side truncation is applied before passing this in.
   */
  doc?: string;
}

export interface PlatformPromptSchema {
  properties?: Record<string, unknown>;
  required?: readonly string[];
}

export interface PlatformPromptOptions {
  /** Raw prompt template from the bundle's root package (`prompt.md`). */
  template: string;
  /** Run context — flows into checkpoint/memory sections. */
  context: ExecutionContext;

  /** Display name of the running platform. Default: `"Appstrate"`. */
  platformName?: string;
  /** Run timeout in seconds — surfaced in the `## System` section. */
  timeoutSeconds?: number;

  /**
   * Bundled skills catalogue. Skills are workspace file references, not
   * MCP tools, so they keep a prompt section (tools are advertised via
   * MCP `tools/list` and are deliberately NOT listed in the prompt).
   */
  availableSkills?: ReadonlyArray<PlatformPromptTool>;

  /**
   * Integrations resolved for this run — one entry per declared,
   * installed, and connected integration. Each entry surfaces the
   * integration's description (from its manifest) and, when present,
   * its `INTEGRATION.md` content inlined into the prompt so the agent
   * can read the integration's API documentation alongside the
   * `{ns}__*` tools advertised via MCP `tools/list`. AFPS §3.5.
   */
  integrations?: ReadonlyArray<PlatformPromptIntegration>;

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
   * Opt-in `## Deliverables` section (platform runs only): tells the agent to
   * write anything it produces for the user under `./outputs/`, which the
   * platform sweeps and publishes as durable run documents at finalize. Off by
   * default so the `appstrate run` CLI (no publish target) omits it. Rendered
   * as a platform-managed section BEFORE the raw prompt.
   */
  deliverables?: boolean;

  /** Optional pre-built PromptView; skip if you want to let the helper build one. */
  promptView?: PromptView;
}

export function renderPlatformPrompt(opts: PlatformPromptOptions): string {
  const sections: string[] = [];
  const { context } = opts;
  const input = (context.input as Record<string, unknown>) ?? {};
  const config = context.config ?? {};
  const platformName = opts.platformName ?? "Appstrate";

  // ─── Section model (#368) ─────────────────────────────────────────
  // The platform prompt owns SECTIONS — headers, intro prose, and data
  // dumps the runtime sources from DB/state. Tool USAGE prose lives in
  // each tool's MCP `description` (surfaced via `tools/list`), never in
  // the prompt.
  //
  // That means the Checkpoint / Pinned Slots / Memory sections render
  // their data block when data exists, with no tool-specific footers.
  // If the `pin` tool isn't loaded, no `pin(...)` instructions appear
  // anywhere in the prompt — the absence of the tool from `tools/list`
  // is the gate. Conversely, when the tool ships, its MCP descriptor
  // `description` teaches the LLM how to interact with the data shown
  // in the platform-owned section.

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
      "Use `curl`, `fetch`, or any HTTP client to call public APIs and websites directly.",
  );
  // Pre-installed Python libs (#628). The runtime image bakes common data
  // libraries into the agent venv — stating it here stops agents (and
  // weaker models especially) from running speculative `pip install`
  // steps or spiralling on ModuleNotFoundError before trying the import.
  sections.push(
    "- **Python**: `python3` is available with common data libraries pre-installed " +
      "(`openpyxl`, `pandas`, `requests`, `PyPDF2`). Import them directly — no `pip install` needed. " +
      "Other packages can be added with `pip install` (the environment is discarded when the run ends).",
  );
  if (opts.timeoutSeconds) {
    sections.push(
      `- **Timeout**: You have ${opts.timeoutSeconds} seconds to complete this task. ` +
        "Work efficiently and output your result promptly.",
    );
  }
  // Workspace bullet — only mention `./documents/` when uploads are actually
  // wired. Surfacing it unconditionally caused agents with no file fields to
  // burn tokens listing an empty directory and hypothesising about missing
  // attachments. The matching `## Documents` section below is also gated on
  // `opts.uploads`, so the two stay consistent.
  const hasUploads = (opts.uploads?.length ?? 0) > 0;
  sections.push(
    "- **Workspace**: Your current working directory is the agent workspace. " +
      (hasUploads
        ? "Uploaded documents are available under `./documents/` (relative to cwd) and listed in the `## Documents` section below. "
        : "") +
      "You may use the filesystem for temporary processing during this run only.\n",
  );

  // --- Communication contract ---
  // The platform parses ONLY the typed events your tools emit. Plain
  // assistant text (prose, reasoning, chat-style replies) is never wired
  // to the user — it lives and dies inside this container. Weaker models
  // default to "here are your results: …" free text, which silently
  // reaches no one. State the invariant explicitly so every result,
  // status update, question, or error is routed through a tool call.
  // Kept tool-agnostic (no opt-in tool names) per the #368 section
  // contract — which tool to use is taught by each tool's MCP descriptor
  // `description` (surfaced via `tools/list`), not the prompt.
  sections.push("### Communication");
  sections.push(
    "Anything you write as plain text — outside a tool call — is **never delivered to the user**. " +
      "It stays inside this ephemeral container and is discarded when the run ends. " +
      "The user does not see your prose, your reasoning, or any chat-style reply.\n",
  );
  sections.push(
    "**The only way to communicate with the user is by calling a tool.** " +
      "Every result, status update, intermediate finding, question, or error you want the user " +
      "to receive MUST go through a tool that conveys it. If you would normally end a turn by " +
      'writing a summary or "here are your results", call the appropriate tool instead. ' +
      "If no available tool can carry a given piece of information, that information cannot reach " +
      "the user — do not assume a final text message will be read.\n",
  );

  // Tools are advertised to the model via MCP `tools/list` (name +
  // description + input schema). The prompt deliberately does NOT list
  // them: a partial/stale in-prompt list would contradict the live tool
  // set, and the Communication contract above already states the only
  // platform invariant the model can't infer from `tools/list`. Skills
  // (below) are NOT MCP tools — they're workspace files — so they keep
  // their own section.

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

  // --- Integrations ---
  // One section per integration resolved for this run. The integration's
  // tools are advertised via MCP `tools/list` under the `{ns}__*` prefix —
  // we deliberately do NOT list them here. The `### API Documentation`
  // subsection surfaces the integration's `INTEGRATION.md` (AFPS §3.5)
  // verbatim so the LLM can read its API contract without a workspace
  // lookup. Subsection omitted when `doc` is absent / empty.
  if (opts.integrations && opts.integrations.length > 0) {
    for (const integ of opts.integrations) {
      sections.push(`## Integration: ${integ.id}\n`);
      if (integ.description) {
        sections.push(`${integ.description}\n`);
      }
      if (integ.doc && integ.doc.trim().length > 0) {
        sections.push("### API Documentation\n");
        sections.push(integ.doc);
        sections.push("");
      }
    }
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
  // Data-only section: renders the snapshot from the prior run when one
  // exists. How to update it (or whether the agent can at all) is
  // determined by which tools are loaded — the relevant tool's MCP
  // descriptor `description` (e.g. `pin`, surfaced via `tools/list`)
  // carries the call instructions. With no such tool the snapshot is
  // implicit read-only carry-over.
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
      "Use this checkpoint to resume work, avoid reprocessing data, or build on previous results.\n",
    );
  }

  // --- Pinned Slots (named, non-checkpoint) ---
  // Data-only section: dumps named pinned slots (any key other than
  // "checkpoint") so they are visible on every run. Update instructions
  // belong to the tool that owns the slot semantics (the `pin` tool's
  // MCP descriptor `description`) and are surfaced via `tools/list`.
  if (context.pinnedSlots && Object.keys(context.pinnedSlots).length > 0) {
    sections.push("## Pinned Slots\n");
    sections.push("Named pinned slots (always visible across runs):\n");
    // Sort keys for deterministic output (snapshot-friendly).
    for (const key of Object.keys(context.pinnedSlots).sort()) {
      const value = context.pinnedSlots[key];
      // Plain strings render as-is for readability; structured values get a
      // fenced JSON block so the agent can parse them unambiguously.
      if (typeof value === "string") {
        sections.push(`### ${key}`, value, "");
      } else {
        sections.push(`### ${key}`, "```json", JSON.stringify(value, null, 2), "```", "");
      }
    }
  }

  // --- Memory ---
  // Data-only section: dumps the agent's pinned memory list (working
  // set, tier 1). The archive tier is reachable via
  // tool calls — those instructions live in each tool's MCP descriptor
  // `description` (`note` for writes, runtime-injected `recall_memory`
  // for searches, surfaced via `tools/list`). Section omitted when no
  // memories are pinned.
  if (context.memories && context.memories.length > 0) {
    sections.push("## Memory\n");
    sections.push("Pinned memories (always visible across runs):\n");
    for (const mem of context.memories) {
      const date = mem.createdAt ? ` (${new Date(mem.createdAt).toISOString()})` : "";
      sections.push(`- ${mem.content}${date}`);
    }
    sections.push("");
  }

  // --- Deliverables (platform-managed, opt-in) ---
  // One concise line so the agent knows where to place anything it produces
  // for the user; the platform sweeps `./outputs/` at finalize and publishes
  // each file as a durable run document. Rendered here — before the raw prompt
  // (and before Output Format) — so the raw user prompt stays strictly last.
  if (opts.deliverables) {
    sections.push("## Deliverables\n");
    sections.push(
      "Write any file you produce for the user (generated documents, exports, data files) " +
        "under `./outputs/` — everything there is published automatically as a downloadable " +
        "document when the run ends. If the user expects a written report or summary, write it " +
        "as markdown to `./outputs/report.md`.\n",
    );
  }

  // --- Output format ---
  // Rendered LAST so the constraint is freshly in the LLM's context when
  // it reads the agent task prompt below. See `outputSchema` docstring
  // for why this duplicates the tool-level schema.
  if (opts.outputSchema && Object.keys(opts.outputSchema).length > 0) {
    sections.push("## Output Format\n");
    sections.push(
      "You MUST call the `output` tool **exactly once**, as your FINAL action, " +
        "with a `data` parameter that satisfies the JSON Schema below. " +
        "Provide ALL required fields in that single call — do not probe " +
        "with `output({})` first, and do not split the payload across " +
        "multiple calls. A successful `output` call ends the run immediately: " +
        "finish all other work before calling it, and do not plan any message " +
        "or step after it.\n",
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

  return sections.join("\n") + "\n---\n\n" + opts.template;
}
