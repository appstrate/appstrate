/** Write a JSON line to stdout (agent ↔ platform protocol). */
export function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/** Emit a user-facing log with explicit severity level. */
export function log(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  data?: Record<string, unknown>,
): void {
  emit({ type: "log", level, message, ...(data ? { data } : {}) });
}

/** Emit a report chunk (streamed markdown content). */
export function emitReport(content: string, final = false): void {
  emit({ type: "report", content, final });
}

/** Emit structured output data (deep-merged by platform). */
export function emitStructuredOutput(data: Record<string, unknown>): void {
  emit({ type: "structured_output", data });
}

/** Set execution state for next run (last call wins). */
export function emitSetState(state: Record<string, unknown>): void {
  emit({ type: "set_state", state });
}

/** Add a long-term memory entry. */
export function emitAddMemory(content: string): void {
  emit({ type: "add_memory", content });
}
