// SPDX-License-Identifier: Apache-2.0

/** Levels of `cause` walked: deeper than any wrapping the drivers and SDKs used here do. */
const MAX_CAUSE_DEPTH = 8;

/** `err`, or the first error down its `cause` chain that `match` accepts. */
export function findCause(
  err: unknown,
  match: (e: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  let current: unknown = err;
  for (let depth = 0; current != null && depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== "object") break;
    const node = current as Record<string, unknown>;
    if (match(node)) return node;
    current = node.cause;
  }
  return undefined;
}
