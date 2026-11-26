// SPDX-License-Identifier: Apache-2.0

/**
 * What counts as a lookup, for the thread and the context panel alike ({@link isLookupCall}), and
 * which assistant parts fold together (`reads-group.tsx` draws the group): reasoning, and the
 * lookups.
 */

import { deriveToolPhase } from "./tool-result.ts";

/** Where a call stands: the thread's phase (`deriveToolPhase`) or the panel's status. */
type CallStanding = "pending" | "running" | "success" | "error" | "denied";

/**
 * A lookup: a call the engine stamped one before it ran (`appstrate.lookup` in the call's provider
 * metadata, `pi-chat/ui-stream-mapper.ts`), unless it failed or was denied, which shows it with
 * the actions. `metadata` is the call's provider metadata: `providerMetadata` of an assistant-ui
 * part, `callProviderMetadata` of the stored part it is converted from.
 */
export function isLookupCall(metadata: unknown, standing: CallStanding): boolean {
  const stamp = (metadata as { appstrate?: { lookup?: unknown } } | undefined)?.appstrate?.lookup;
  return stamp === true && standing !== "error" && standing !== "denied";
}

/** What the grouping reads of an assistant-ui part. */
interface GroupablePart {
  readonly type: string;
  readonly providerMetadata?: unknown;
  readonly status?: { readonly type: string } | undefined;
  readonly result?: unknown;
  readonly isError?: boolean | undefined;
}

/** Group paths of the assistant parts: reasoning and lookups fold into one activity group. */
export function activityGroupOf(
  part: GroupablePart,
): readonly ("group-activity" | "group-reasoning")[] | null {
  if (part.type === "reasoning") return ["group-activity", "group-reasoning"];
  if (part.type === "tool-call" && isLookupCall(part.providerMetadata, deriveToolPhase(part))) {
    return ["group-activity"];
  }
  return null;
}
