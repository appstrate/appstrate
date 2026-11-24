// SPDX-License-Identifier: Apache-2.0

/**
 * Which parts of an assistant turn fold into its thought block: the reasoning
 * and the tool calls the agent makes along the way. React-free, so the rule is
 * unit-tested without a DOM.
 *
 * A tool call stays out of the block, visible in the transcript, when the user
 * has something to do or to see in it: the connect card, the run in progress,
 * the package it created, or a call waiting for the user. Everything else is a
 * step of the agent's work, errors included: a failed call the agent recovers
 * from is not information for the user, and one that ends the turn surfaces as
 * the turn's error.
 */

import { unwrapMcpResult } from "@appstrate/core/mcp-result";
import { asRecordOrNull } from "@appstrate/core/safe-json";
import { packageCreatedByImport, packageCreatedByOperation } from "./package-created.ts";
import { isRunLaunchOp } from "./run-events.ts";
import { deriveToolPhase } from "./tool-result.ts";

/**
 * `invoke_operation` operationId that kicks off an integration connect flow.
 * `initiateIntegrationConnect` is the unified, auth-type-agnostic op whose
 * result carries a `connect_url`; it renders the connect card (button +
 * auto-resume on completion, see `oauth-connect-card.tsx`).
 */
export const INITIATE_CONNECT_OP = "initiateIntegrationConnect";

/** The one group key: reasoning and tool calls coalesce into the same block. */
export const THOUGHT_GROUP = "group-thought";
const THOUGHT_PATH = [THOUGHT_GROUP] as const;

/** The subset of an assistant-ui part the rule reads. */
interface ThoughtPartInput {
  type: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  status?: { type?: string; reason?: string };
}

function operationIdOf(args: unknown): string {
  const id = asRecordOrNull(args)?.operation_id;
  return typeof id === "string" ? id : "";
}

/** A tool call whose card the user acts on or reads, so it renders outside the block. */
export function isStandaloneToolCall(part: ThoughtPartInput): boolean {
  if (part.status?.type === "requires-action") return true;
  if (part.toolName === "run_and_wait") return true;
  if (part.toolName === "invoke_operation") {
    const opId = operationIdOf(part.args);
    if (opId === INITIATE_CONNECT_OP || isRunLaunchOp(opId)) return true;
    return (
      deriveToolPhase(part) === "success" &&
      packageCreatedByOperation(opId, unwrapMcpResult(part.result)) !== null
    );
  }
  if (part.toolName === "import_package_file") {
    return (
      deriveToolPhase(part) === "success" &&
      packageCreatedByImport(unwrapMcpResult(part.result)) !== null
    );
  }
  return false;
}

/** Whether the part folds into the thought block. */
export function isThoughtPart(part: ThoughtPartInput): boolean {
  if (part.type === "reasoning") return true;
  return part.type === "tool-call" && !isStandaloneToolCall(part);
}

/** `MessagePrimitive.GroupedParts` `groupBy`: adjacent thought parts share one block, the rest stands alone (`null`). */
export function groupThought(part: ThoughtPartInput): readonly [typeof THOUGHT_GROUP] | null {
  return isThoughtPart(part) ? THOUGHT_PATH : null;
}
