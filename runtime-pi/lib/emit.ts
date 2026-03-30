/** Write a JSON line to stdout (agent ↔ platform protocol). */
export function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
