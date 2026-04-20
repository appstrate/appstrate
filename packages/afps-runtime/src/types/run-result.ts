// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { LogLevel } from "./afps-event.ts";

/**
 * Aggregated state at the end of a run.
 *
 * Built by the runtime by reducing the stream of {@link AfpsEvent} values
 * against the semantics defined in `AFPS_EXTENSION_ARCHITECTURE.md` §6:
 *
 * - `add_memory` events append to `memories`
 * - `set_state` events overwrite `state` (last-write-wins)
 * - `output` events deep-merge into `output` (JSON merge-patch semantics)
 * - `report` events concatenate into `report` with `\n` separators
 * - `log` events append to `logs`
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
