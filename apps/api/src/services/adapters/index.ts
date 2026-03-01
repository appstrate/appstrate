import type { ExecutionAdapter } from "./types.ts";
import { PiAdapter } from "./pi.ts";
import { getEnv } from "@appstrate/env";

export { TimeoutError } from "./types.ts";
export type { TokenUsage } from "./types.ts";
export { buildRetryPrompt } from "./prompt-builder.ts";

export function getAdapter(): ExecutionAdapter {
  const type = getEnv().EXECUTION_ADAPTER;
  switch (type) {
    case "pi":
      return new PiAdapter();
    default:
      throw new Error(`Unknown execution adapter: ${type}`);
  }
}
