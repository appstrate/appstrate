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

