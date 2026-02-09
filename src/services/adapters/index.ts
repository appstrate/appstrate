import type { ExecutionAdapter } from "./types.ts";
import { DockerAdapter, TimeoutError } from "./docker.ts";
import { ClaudeCodeAdapter, ClaudeCodeTimeoutError } from "./claude-code.ts";

export type { ExecutionAdapter, ExecutionMessage } from "./types.ts";
export { TimeoutError, ClaudeCodeTimeoutError };

export function getAdapter(): ExecutionAdapter {
  const type = process.env.EXECUTION_ADAPTER || "docker";
  if (type === "claude-code") return new ClaudeCodeAdapter();
  return new DockerAdapter();
}

export function getAdapterName(): string {
  return process.env.EXECUTION_ADAPTER || "docker";
}
