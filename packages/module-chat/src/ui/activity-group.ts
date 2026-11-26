// SPDX-License-Identifier: Apache-2.0

/**
 * What counts as a lookup for the context panel ({@link isLookupCall}), and which assistant parts
 * fold together in the thread (`activity-group-view.tsx` draws the group): reasoning, and the
 * lookups known before they run.
 */

import type { ToolPresentation } from "@appstrate/core/mcp-presentation";
import { deriveToolPhase } from "./tool-result.ts";

/** Where a call stands: the thread's phase (`deriveToolPhase`) or the panel's status. */
type CallStanding = "pending" | "running" | "success" | "error" | "denied";

/** The methods that only read (RFC 9110 §9.2.1 safe methods a client issues to look). */
const READ_METHODS = new Set(["GET", "HEAD"]);

/** A failed or denied call shows with the actions, whatever it looked up. */
function failed(standing: CallStanding): boolean {
  return standing === "error" || standing === "denied";
}

/**
 * The call of a tool that only looks things up, as the engine stamped it before it ran
 * (`appstrate.lookup` in the call's provider metadata, `pi-chat/ui-stream-mapper.ts`). `metadata`
 * is `providerMetadata` of an assistant-ui part, `callProviderMetadata` of the stored part it is
 * converted from.
 */
function stampedLookup(metadata: unknown): boolean {
  return (metadata as { appstrate?: { lookup?: unknown } } | undefined)?.appstrate?.lookup === true;
}

/**
 * A lookup, as the context panel counts it, unless it failed or was denied: a stamped call
 * ({@link stampedLookup}), or a call whose presentation names a read (`GET` or `HEAD`), an
 * operation or a single proxied request, known once its result lands. `presentation` is read off
 * the stored part (`callPresentation`).
 */
export function isLookupCall(
  metadata: unknown,
  presentation: ToolPresentation | undefined,
  standing: CallStanding,
): boolean {
  if (failed(standing)) return false;
  if (stampedLookup(metadata)) return true;
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
 * Group paths of the assistant parts: reasoning and the stamped lookups fold into one activity
 * group. Only what is known as a call starts groups it, so a card never moves when its result
 * lands; a lookup that fails or is denied leaves the group, its card showing the error among the
 * actions.
 */
export function activityGroupOf(
  part: GroupablePart,
): readonly ("group-activity" | "group-reasoning")[] | null {
  if (part.type === "reasoning") return ["group-activity", "group-reasoning"];
  if (
    part.type === "tool-call" &&
    stampedLookup(part.providerMetadata) &&
    !failed(deriveToolPhase(part))
  ) {
    return ["group-activity"];
  }
  return null;
}
