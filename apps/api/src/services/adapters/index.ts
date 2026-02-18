import type { ExecutionAdapter } from "./types.ts";
import { PiAdapter } from "./pi.ts";

export { TimeoutError } from "./types.ts";
export type { TokenUsage, FileReference, PromptContext } from "./types.ts";
export { buildRetryPrompt } from "./prompt-builder.ts";

export function getAdapter(): ExecutionAdapter {
  const type = process.env.EXECUTION_ADAPTER || "pi";
  switch (type) {
    case "pi":
      return new PiAdapter();
    default:
      throw new Error(`Unknown execution adapter: ${type}`);
  }
}

export function getAdapterName(): string {
  return process.env.EXECUTION_ADAPTER || "pi";
}
