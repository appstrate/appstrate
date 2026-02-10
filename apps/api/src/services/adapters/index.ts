import type { ExecutionAdapter } from "./types.ts";
import { ClaudeCodeAdapter, TimeoutError } from "./claude-code.ts";

export type { ExecutionAdapter, ExecutionMessage } from "./types.ts";
export { TimeoutError };

export function getAdapter(): ExecutionAdapter {
  const type = process.env.EXECUTION_ADAPTER || "claude-code";
  if (type === "claude-code") return new ClaudeCodeAdapter();
  throw new Error(`Unknown execution adapter: ${type}`);
}

export function getAdapterName(): string {
  return process.env.EXECUTION_ADAPTER || "claude-code";
}
