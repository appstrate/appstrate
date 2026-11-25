// SPDX-License-Identifier: Apache-2.0

/**
 * Which parts of an assistant turn fold into its thought block: the reasoning
 * and the tool calls the agent makes along the way. React-free, so the rule is
 * unit-tested without a DOM.
 *
 * A tool call stays out of the block, visible in the transcript, when the user
 * has something to do in it: the connect card, the run in progress, or a call
 * waiting for the user. Everything else is a
 * step of the agent's work, errors included: a failed call the agent recovers
 * from is not information for the user, and one that ends the turn surfaces as
 * the turn's error.
 */

import { asRecordOrNull } from "@appstrate/core/safe-json";
import { isRunLaunchOp } from "./run-events.ts";

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

/**
 * A tool call whose card the user acts on, so it renders outside the block.
 * The package a call created stays in the block, as its last row with the link.
 */
export function isStandaloneToolCall(part: ThoughtPartInput): boolean {
  if (part.status?.type === "requires-action") return true;
  if (part.toolName === "run_and_wait") return true;
  if (part.toolName === "invoke_operation") {
    const opId = operationIdOf(part.args);
    return opId === INITIATE_CONNECT_OP || isRunLaunchOp(opId);
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

/** Verb label of an Appstrate API operation, by prefix: a heuristic, not an operationId map. */
export const OP_LABEL_RULES: { re: RegExp; labelKey: string }[] = [
  { re: /^(run|trigger|execute|start)/i, labelKey: "tool.op.launch" },
  { re: /^(create|post|add|import|upload)/i, labelKey: "tool.op.create" },
  { re: /^(update|patch|put|set|rename|configure)/i, labelKey: "tool.op.update" },
  { re: /^(delete|remove|cancel|archive)/i, labelKey: "tool.op.delete" },
  { re: /^(list|get|search|find|read)/i, labelKey: "tool.op.read" },
];

function stringArgOf(args: unknown, key: string): string | undefined {
  const value = asRecordOrNull(args)?.[key];
  return typeof value === "string" && value ? value : undefined;
}

/**
 * What a step reads as in one line: a translation key and the call's target.
 * The thought block's header shows it for the step in progress.
 */
export function stepLabel(part: ThoughtPartInput): {
  labelKey?: string;
  label?: string;
  target?: string;
} {
  if (part.type === "reasoning") return {};
  switch (part.toolName) {
    case "invoke_operation": {
      const opId = operationIdOf(part.args);
      const rule = OP_LABEL_RULES.find((r) => r.re.test(opId));
      return { labelKey: rule?.labelKey ?? "tool.op.other", target: opId || undefined };
    }
    case "search":
      return { labelKey: "tool.search", target: stringArgOf(part.args, "query") };
    case "describe":
      return { labelKey: "tool.describe", target: stringArgOf(part.args, "id") };
    case "import_package_file":
      return { labelKey: "tool.importPackageFile", target: stringArgOf(part.args, "file_uri") };
    default:
      return { label: part.toolName ?? "" };
  }
}
