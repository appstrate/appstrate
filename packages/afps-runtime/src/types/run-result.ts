// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Severity levels carried by `log.written` run events. Mirrored on the
 * aggregated {@link LogEntry} so the reducer can surface the same
 * vocabulary back to callers.
 */
export type LogLevel = "info" | "warn" | "error";

/**
 * Aggregated state at the end of a run.
 *
 * Built by the runtime by reducing the stream of {@link RunEvent} values
 * against the canonical AFPS 1.3 semantics:
 *
 * - `memory.added` events append to `memories`
 * - `state.set` events overwrite `state` (last-write-wins)
 * - `output.emitted` events deep-merge into `output` (JSON merge-patch)
 * - `report.appended` events concatenate into `report` with `\n` separators
 * - `log.written` events append to `logs`
 *
 * Passed to {@link EventSink.finalize} when the run ends.
 */
export interface RunResult {
  memories: Memory[];
  state: unknown | null;
  output: unknown | null;
  report: string | null;
  logs: LogEntry[];
  error?: RunError;
  /**
   * Terminal status hint. Optional — the reducer does not populate it (events
   * alone cannot distinguish "success" from "cancelled by signal"). Runners
   * that surface a specific terminal cause (timeout, cancellation) set this
   * before calling {@link EventSink.finalize} so downstream ingestion can
   * persist the exact `runs.status` without inferring from `error` text.
   *
   * When absent, consumers default to `"failed"` if `error` is set, else
   * `"success"`.
   */
  status?: "success" | "failed" | "timeout" | "cancelled";
  /** Elapsed wall-clock time in milliseconds. Runners populate this. */
  durationMs?: number;
  /**
   * Authoritative token usage for the run. When present, downstream
   * consumers MUST treat this as the source of truth — the field exists
   * so finalize is self-contained and does not race with the side-channel
   * `appstrate.metric` event whose POST may not have landed yet. Runners
   * that produce no LLM traffic (CLI replay, tests) leave this absent.
   */
  usage?: TokenUsage;
  /**
   * Authoritative LLM cost in USD for the runner-source contribution
   * (i.e. the cost the runner itself observed for its own LLM calls).
   * Travels with the finalize POST so cost accounting does not depend on
   * the `appstrate.metric` event having been ingested before finalize.
   * Combines with proxy + credential-proxy ledgers downstream — does NOT
   * include those, only the runner's view.
   */
  cost?: number;
}

/**
 * Snake-case token-usage shape carried on {@link RunResult.usage} and the
 * `appstrate.metric` event. Mirrors the platform's `runs.tokenUsage` JSONB
 * column shape so finalize can persist it directly without re-mapping.
 */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface Memory {
  content: string;
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: number;
}

/**
 * Error envelope for a failed run.
 *
 * Shape is **MCP-aligned / JSON-RPC-inspired** — `code` / `message` /
 * supplementary data via `context` mirror the JSON-RPC 2.0 error object so
 * AFPS-runtime consumers can adopt MCP/JSON-RPC tooling with minimal glue
 * (#276 alignment). It is NOT a strict JSON-RPC error: `code` here is an
 * optional string identifier (e.g. `"timeout"`, `"manifest_invalid"`),
 * whereas JSON-RPC mandates a required integer code. Runtime callers that
 * need wire-compatible JSON-RPC errors must map `code` themselves.
 *
 * All fields beyond `message` are optional and additive — runners that
 * previously emitted `{ message, stack? }` continue to round-trip through
 * the type unchanged.
 */
export interface RunError {
  /**
   * Stable error code (e.g. `"timeout"`, `"manifest_invalid"`,
   * `"provider_unauthorized"`). Optional; absent for free-form runner errors.
   * Codes carry stronger semantics than message strings — sinks and webhooks
   * SHOULD branch on `code`, not `message`. Note this is a string identifier,
   * not the integer required by strict JSON-RPC 2.0.
   */
  code?: string;
  /** Human-readable message. Required. */
  message: string;
  /**
   * Stack trace when available. Runners are encouraged to omit this in
   * production builds where it would leak internal paths.
   */
  stack?: string;
  /**
   * Structured supplementary data — provider id, target URI, retry count,
   * upstream status code, etc. Mirrors the JSON-RPC 2.0 `data` slot.
   * Bounded — sinks may truncate large payloads to avoid amplifying retries.
   */
  context?: Record<string, unknown>;
  /** RFC 3339 ISO-8601 UTC timestamp when the error was observed. */
  timestamp?: string;
}
