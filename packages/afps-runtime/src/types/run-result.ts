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

export interface RunError {
  message: string;
  stack?: string;
}
