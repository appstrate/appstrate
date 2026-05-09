// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Tool descriptors for the LLM-facing tools the platform runtime wires
 * outside the AFPS bundle dependency tree.
 *
 * Bundle-declared tools (e.g. `@appstrate/pin`, `@appstrate/note`) ship
 * their own `manifest.json` + `TOOL.md` and are surfaced to the LLM
 * automatically by `@appstrate/afps-runtime/bundle`'s
 * `buildPlatformPromptInputs`. A handful of tools, however, are wired
 * by the runtime container itself and are NEVER bundle packages —
 * `run_history` and `recall_memory` are platform capabilities backed
 * by the sidecar, not user-shippable code.
 *
 * Without a bundle there is no `manifest.tool.name` for the prompt
 * gate to key off, no `description` for the `### Tools` listing, and
 * no `TOOL.md` to teach the LLM how to call the tool. The descriptors
 * exported here close those three gaps with a single source of truth:
 *
 *   1. The runtime container (`runtime-pi/mcp/direct.ts`) imports them
 *      to build its Pi tool registrations — name + description match
 *      the sidecar's MCP advertisement (`runtime-pi/sidecar/mcp.ts`).
 *   2. The platform prompt builder (`apps/api/services/adapters/
 *      prompt-builder.ts`) imports them to extend `availableTools` and
 *      `toolDocs` so the LLM sees the same `### Tools` entry + usage
 *      doc it would for a bundle-shipped tool.
 *
 * Adding a new runtime-injected tool means appending one entry here —
 * no edits to platform-prompt.ts (which has no knowledge of specific
 * tool names) and no per-tool gating to maintain. The presence of the
 * `doc` fragment in the prompt is the implicit gate: if the runtime
 * wires the tool, its doc is rendered; otherwise the LLM never sees
 * an instruction to call it.
 */

/**
 * Descriptor for a tool wired by the runtime container outside of any
 * AFPS bundle package. Mirrors the shape of `PlatformPromptTool` plus
 * a `doc` carrying the equivalent of a bundle's `TOOL.md`, plus a
 * `parameters` JSON Schema describing the tool's call surface.
 *
 * Together these four fields are sufficient for both consumers:
 *   - The platform prompt builder uses `id`/`name`/`description`/`doc`
 *     to extend `availableTools` and `toolDocs`.
 *   - The runtime container uses `name`/`description`/`parameters` to
 *     register a generic MCP-forwarding Pi tool.
 *
 * Adding a new runtime-injected tool means appending one entry below.
 * No edits anywhere else.
 */
export interface RuntimeInjectedTool {
  /** Stable tool id — same string used as `id` and `name` since these tools have no package identity. */
  readonly id: string;
  /** LLM-facing tool name. Must match what the sidecar advertises via MCP. */
  readonly name: string;
  /** Short description shown in the `### Tools` listing and in MCP tool advertisements. */
  readonly description: string;
  /**
   * JSON Schema for the tool's `arguments` payload (i.e. the LLM-facing
   * call surface). Used by the runtime container to register the Pi
   * tool with the same shape the sidecar advertises via MCP. Plain
   * JSON Schema so this module stays free of Pi-AI / typebox imports —
   * the runtime wraps it with `Type.Unsafe(schema)` at registration.
   */
  readonly parameters: Readonly<Record<string, unknown>>;
  /**
   * `TOOL.md`-equivalent doc: a complete prose fragment that teaches
   * the LLM how to use the tool — parameters, scoping, common
   * patterns. Rendered alongside bundle `TOOL.md`s in the platform
   * prompt's tool-doc area. Should start with a level-2 markdown
   * heading (`## tool_name`) for visual parity with bundle docs.
   */
  readonly doc: string;
}

const RUN_HISTORY_DOC = `## run_history

Use \`run_history({ limit?, fields? })\` to fetch metadata about recent past runs of this agent (the current run is excluded). Returned entries always include core metadata (run id, timestamps, status, trigger). To include heavier payloads, opt-in via \`fields\`:

- \`fields: ["checkpoint"]\` — include each run's saved checkpoint snapshot.
- \`fields: ["result"]\` — include each run's structured output (\`output\` tool payload).
- Pass both for the full picture.

\`limit\` defaults to a small number; bump it (max 50) to look further back.

Common uses: deciding whether a prior run already processed something, diagnosing an unexpected state by inspecting prior outputs, replaying logic against a previous checkpoint shape during migrations.`;

const RECALL_MEMORY_DOC = `## recall_memory

Use \`recall_memory({ q?, limit? })\` to search the agent's archive memory store. Archive memories are durable facts and learnings written via \`note({ content })\` — they persist across runs but are NOT injected into the system prompt by default (only pinned memories are, and only when the platform's \`## Memory\` section is rendered).

- \`q\` — case-insensitive substring filter. Omit it to get the most recent archive entries.
- \`limit\` — cap on results (max 50).

Pair with \`note\` (from \`@appstrate/note\`) to write new entries: \`note\` saves to the archive, \`recall_memory\` searches it. Use \`pin({ key, content })\` (from \`@appstrate/pin\`) instead when the data must be visible on every run rather than fetched on demand.`;

/**
 * Descriptor for `run_history`. Mirrors `runtime-pi/sidecar/mcp.ts`'s
 * registration; if the sidecar's parameter schema or behaviour
 * changes, update this descriptor and the sidecar in lockstep.
 */
export const RUN_HISTORY_INJECTED_TOOL: RuntimeInjectedTool = {
  id: "run_history",
  name: "run_history",
  description:
    "Fetch metadata and optionally checkpoint/result of recent past runs (current run excluded).",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 50 },
      fields: {
        type: "array",
        items: { type: "string", enum: ["checkpoint", "result"] },
        uniqueItems: true,
      },
    },
  },
  doc: RUN_HISTORY_DOC,
};

/**
 * Descriptor for `recall_memory`. The sidecar advertises the same
 * wording so MCP-list output matches the Pi-tool registration verbatim.
 */
export const RECALL_MEMORY_INJECTED_TOOL: RuntimeInjectedTool = {
  id: "recall_memory",
  name: "recall_memory",
  description:
    "Search the agent's archive memories — durable facts and learnings from past runs that " +
    "are NOT in the system prompt by default. Pass `q` to filter by case-insensitive " +
    "substring; omit it for the most recent archive memories.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      q: { type: "string", minLength: 1, maxLength: 2000 },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
  },
  doc: RECALL_MEMORY_DOC,
};

/**
 * Canonical list of runtime-injected tools, in the order they should
 * appear in the `### Tools` listing and `toolDocs` block.
 *
 * Order rationale: `run_history` first because it's pure metadata
 * (read-only, no state mutation), `recall_memory` second because it
 * pairs naturally with `note` (which the agent typically already has
 * from `@appstrate/note` if memory is in scope).
 */
export const RUNTIME_INJECTED_TOOLS: ReadonlyArray<RuntimeInjectedTool> = [
  RUN_HISTORY_INJECTED_TOOL,
  RECALL_MEMORY_INJECTED_TOOL,
];
