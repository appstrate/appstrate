// SPDX-License-Identifier: Apache-2.0

/**
 * Human approval before the chat writes. A Pi `tool_call` extension asks the
 * host for an answer before any platform MCP tool that is not read-only runs:
 * the MCP `readOnlyHint` annotation decides, and for `invoke_operation` the
 * operation's HTTP method does (`GET` passes, anything else asks). A refusal
 * blocks the call natively (`{ block: true, reason }`) and the model reads the
 * reason as the tool's error result. A handler that throws also blocks: Pi
 * refuses to run a call whose `tool_call` handler failed.
 *
 * The decision is the host's, never the prompt's: the model cannot skip it.
 */

import type { ExtensionFactory } from "@appstrate/runner-pi";
import type { ApprovalDecision } from "../approval-registry.ts";
import type { PlatformMcpSurface } from "./mcp-surface-cache.ts";
import { stripMcpToolPrefix } from "./ui-stream-mapper.ts";

const INVOKE_OPERATION_TOOL = "invoke_operation";

export interface ApprovalRequest {
  toolCallId: string;
  /** What the call does, in a line the approval card shows. */
  reason: string;
}

/** Ask the person, wait for the answer. Owned by the turn (stream + registry). */
export type RequestApproval = (request: ApprovalRequest) => Promise<ApprovalDecision>;

interface OperationSummary {
  method?: string;
  summary?: string;
}

/** Read `method` + `summary` from a `describe_operation` MCP result; `{}` when unreadable. */
function parseOperationSummary(result: unknown): OperationSummary {
  const block = (result as { content?: Array<{ type?: string; text?: string }> })?.content?.[0];
  if (block?.type !== "text" || typeof block.text !== "string") return {};
  try {
    const payload = JSON.parse(block.text) as Record<string, unknown>;
    return {
      ...(typeof payload.method === "string" ? { method: payload.method } : {}),
      ...(typeof payload.summary === "string" && payload.summary
        ? { summary: payload.summary }
        : {}),
    };
  } catch {
    return {};
  }
}

export function createToolApprovalExtension(opts: {
  tools: PlatformMcpSurface["tools"];
  /** `describe_operation` on the turn's MCP client (raw MCP result). */
  describeOperation: (operationId: string) => Promise<unknown>;
  requestApproval: RequestApproval;
}): ExtensionFactory {
  const tools = new Map(opts.tools.map((tool) => [stripMcpToolPrefix(tool.name), tool]));
  // Per turn: the model usually describes an operation right before invoking it.
  const operations = new Map<string, Promise<OperationSummary>>();
  const describe = (operationId: string): Promise<OperationSummary> => {
    let found = operations.get(operationId);
    if (!found) {
      // An unknown operation reads as `{}`, and `{}` asks.
      found = opts.describeOperation(operationId).then(parseOperationSummary, () => ({}));
      operations.set(operationId, found);
    }
    return found;
  };

  return (pi) => {
    pi.on("tool_call", async (event) => {
      const tool = tools.get(event.toolName);
      if (!tool || tool.annotations?.readOnlyHint === true) return undefined;

      let reason = tool.annotations?.title ?? event.toolName;
      if (event.toolName === INVOKE_OPERATION_TOOL) {
        const operationId = event.input.operation_id;
        const op = typeof operationId === "string" ? await describe(operationId) : {};
        if (op.method === "GET") return undefined;
        if (op.summary) reason = op.summary;
      }

      const decision = await opts.requestApproval({ toolCallId: event.toolCallId, reason });
      if (decision.approved) return undefined;
      return {
        block: true,
        reason: decision.reason
          ? `The user denied this tool call: ${decision.reason}`
          : "The user denied this tool call.",
      };
    });
  };
}
