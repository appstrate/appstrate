import { PiAdapter } from "./pi.ts";

export { TimeoutError } from "./types.ts";
export type { TokenUsage } from "./types.ts";

export function getAdapter() {
  return new PiAdapter();
}
