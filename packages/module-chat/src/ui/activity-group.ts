// SPDX-License-Identifier: Apache-2.0

/**
 * Which assistant parts fold together (`reads-group.tsx` draws the group): reasoning,
 * and the calls the engine stamped a lookup before they ran
 * (`providerMetadata.appstrate.lookup`, `pi-chat/ui-stream-mapper.ts`), unless they
 * failed — an error stays inline.
 */

import { deriveToolPhase } from "./tool-result.ts";

/** What the grouping reads of a part. */
interface GroupablePart {
  readonly type: string;
  readonly providerMetadata?: unknown;
  readonly status?: { readonly type: string } | undefined;
  readonly result?: unknown;
  readonly isError?: boolean | undefined;
}

/** A tool call stamped a lookup that has not failed. */
export function isFoldableRead(part: GroupablePart): boolean {
  if (part.type !== "tool-call") return false;
  const stamp = (part.providerMetadata as { appstrate?: { lookup?: unknown } } | undefined)
    ?.appstrate?.lookup;
  if (stamp !== true) return false;
  return deriveToolPhase(part) !== "error";
}

/** Group paths of the assistant parts: reasoning and reads fold into one activity group. */
export function activityGroupOf(
  part: GroupablePart,
): readonly ("group-activity" | "group-reasoning")[] | null {
  if (part.type === "reasoning") return ["group-activity", "group-reasoning"];
  if (isFoldableRead(part)) return ["group-activity"];
  return null;
}
