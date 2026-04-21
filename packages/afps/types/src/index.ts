// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Appstrate contributors

/**
 * @afps/types — TypeScript bindings for AFPS 1.3+ contracts.
 *
 * Canonical TS projection of the language-agnostic AFPS specification
 * (see afps-spec/spec.md §8). These are the contracts every AFPS-
 * compliant TypeScript tool, runtime, and runner must agree on:
 *
 *   - Manifest refs — parallel to the Zod schemas in @afps-spec/schema.
 *   - Tool protocol — what every tool implementation must satisfy.
 *   - RunEvent wire envelope — events flowing from tools to sinks.
 *
 * This package declares types only — no runtime behavior. Runtime-
 * internal interfaces (bundle loader APIs, resolver interfaces, sink
 * interfaces, aggregated run state) live in the runtime package that
 * owns the implementation (e.g. @appstrate/afps-runtime).
 */

// ─────────────────────────────────────────────
// Manifest refs — parallel to the Zod schemas in @afps-spec/schema
// ─────────────────────────────────────────────

/** A dependency reference as declared in the agent manifest. */
export interface DependencyRef {
  /** Scoped package name (e.g. "@afps/memory"). */
  name: string;
  /** Semver range the resolver matches against (e.g. "^1.0.0"). */
  version: string;
}

export type ToolRef = DependencyRef;
export type ProviderRef = DependencyRef;
export type SkillRef = DependencyRef;

/**
 * JSON-Schema-shaped parameter definition for a tool.
 * Kept as `unknown` at this layer to avoid pinning a specific JSON Schema
 * library; runtimes and tools are free to use their preferred typing.
 */
export type JSONSchema = Record<string, unknown>;

// ─────────────────────────────────────────────
// Tool protocol — the contract every AFPS tool must satisfy
// ─────────────────────────────────────────────

/**
 * A Tool is the unit of capability surfaced to the LLM. Tools produced
 * by a runtime's tool resolver and by its provider resolver share this
 * contract — the LLM cannot tell them apart.
 */
export interface Tool {
  /** Tool name as exposed to the LLM (e.g. "add_memory", "gmail_call"). */
  name: string;
  description: string;
  parameters: JSONSchema;
  /**
   * Execute the tool with parsed arguments. MUST NOT throw for normal
   * business failures — encode those as a non-ok ToolResult so the LLM
   * can recover. Throwing should be reserved for runtime faults.
   */
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * Contract passed to a Tool at execution time.
 *
 * The context is the only path by which a tool communicates with the
 * rest of the runtime: via structured events (emit), the workspace
 * (on-disk scratch area), and cancellation (signal).
 */
export interface ToolContext {
  /** Emit a RunEvent to the runner's event sink. Non-blocking. */
  emit(event: RunEvent): void;
  /** Absolute path to the run's scratch workspace directory. */
  workspace: string;
  /** Abort signal tied to the run; tool implementations SHOULD respect it. */
  signal: AbortSignal;
  /** Stable identifier for the current run. */
  runId: string;
  /** LLM-assigned identifier for this specific tool call, when available. */
  toolCallId?: string;
}

/**
 * Tool result surfaced back to the LLM.
 *
 * The `content` array mirrors the MCP/Anthropic tool-result format so
 * that runtimes can forward results with minimal translation. Binary
 * payloads SHOULD be surfaced as file references (see spec §8.4) rather
 * than inline bytes.
 */
export interface ToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "resource"; uri: string; mimeType?: string }
  >;
  isError?: boolean;
}

// ─────────────────────────────────────────────
// RunEvent — open envelope for tool-emitted signals
// ─────────────────────────────────────────────

/**
 * RunEvent — open envelope emitted by tools during a run.
 *
 * The envelope (`type`, `timestamp`, `runId`) is stable so any sink can
 * route events without understanding their payload. The payload itself
 * is an open index signature so tools — including third-party tools —
 * can carry whatever data they need without amending the spec.
 *
 * Reserved `type` namespaces for core AFPS packages:
 *   - memory.*   (@afps/memory)
 *   - state.*    (@afps/state)
 *   - output.*   (@afps/output)
 *   - report.*   (@afps/report)
 *   - log.*      (@afps/log)
 *   - provider.* (@afps/provider-*, provider resolver implementations)
 *
 * Third-party tools SHOULD use their own namespace (e.g. "@my-org/audit.*").
 */
export interface RunEvent {
  /** "<domain>.<verb>" — discriminant chosen by the emitting tool. */
  type: string;
  /** Unix milliseconds at emission time. */
  timestamp: number;
  /** The run's stable identifier. */
  runId: string;
  /** LLM tool-call id, when the event originates from a tool call. */
  toolCallId?: string;
  /** Payload — tool-defined, open schema. */
  [key: string]: unknown;
}
