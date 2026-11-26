// SPDX-License-Identifier: Apache-2.0

/**
 * What counts as a lookup, for the thread and the context panel alike ({@link isLookupCall}), and
 * which assistant parts fold together (`activity-group-view.tsx` draws the group): reasoning, and the
 * lookups.
 */

import type { ToolPresentation } from "@appstrate/core/mcp-presentation";
import { deriveToolPhase } from "./tool-result.ts";

/** Where a call stands: the thread's phase (`deriveToolPhase`) or the panel's status. */
type CallStanding = "pending" | "running" | "success" | "error" | "denied";

/** The methods that only read (RFC 9110 §9.2.1 safe methods a client issues to look). */
const READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * A lookup, unless it failed or was denied, which shows it with the actions:
 * - a call the engine stamped one before it ran (`appstrate.lookup` in the call's provider
 *   metadata, `pi-chat/ui-stream-mapper.ts`), the call of a tool that only looks things up;
 * - a call whose presentation names a read (`GET` or `HEAD`): an operation or a single proxied
 *   request, known once its result lands.
 *
 * `metadata` is the call's provider metadata: `providerMetadata` of an assistant-ui part,
 * `callProviderMetadata` of the stored part it is converted from. `presentation` is read off the
 * stored part (`callPresentation`), the source the call's card reads.
 */
export function isLookupCall(
  metadata: unknown,
  presentation: ToolPresentation | undefined,
  standing: CallStanding,
): boolean {
  if (standing === "error" || standing === "denied") return false;
  const stamp = (metadata as { appstrate?: { lookup?: unknown } } | undefined)?.appstrate?.lookup;
  if (stamp === true) return true;
  const method = presentation?.method?.toUpperCase();
  return method !== undefined && READ_METHODS.has(method);
}

/** What the grouping, and the group, read of an assistant-ui part. */
export interface GroupablePart {
  readonly type: string;
  readonly toolCallId?: string;
  readonly providerMetadata?: unknown;
  readonly status?: { readonly type: string } | undefined;
  readonly result?: unknown;
  readonly isError?: boolean | undefined;
}

/**
 * Group paths of the assistant parts: reasoning and lookups fold into one activity group.
 * `presentation` is the part's call's, when it is one.
 */
export function activityGroupOf(
  part: GroupablePart,
  presentation: ToolPresentation | undefined,
): readonly ("group-activity" | "group-reasoning")[] | null {
  if (part.type === "reasoning") return ["group-activity", "group-reasoning"];
  if (
    part.type === "tool-call" &&
    isLookupCall(part.providerMetadata, presentation, deriveToolPhase(part))
  ) {
    return ["group-activity"];
  }
  return null;
}
