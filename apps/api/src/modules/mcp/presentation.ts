// SPDX-License-Identifier: Apache-2.0

/** The presentation stamped on the platform's MCP tool results (`@appstrate/core/mcp-presentation`). */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";
import {
  TOOL_PRESENTATION_META_KEY,
  type PresentationSubject,
  type ToolPresentation,
} from "@appstrate/core/mcp-presentation";
import { asRecord } from "@appstrate/core/safe-json";
import { unwrapMcpResult } from "@appstrate/core/mcp-result";
import { logger } from "../../lib/logger.ts";
import { getCatalog } from "./catalog.ts";
import { jsonResult } from "./tool-results.ts";
import { toolIcons } from "./tool-icons.ts";
import type { McpToolName } from "./tools.ts";

/** `result` with `presentation` stamped, replacing any stamp it carried. */
export function withPresentation(
  result: CallToolResult,
  presentation: ToolPresentation,
): CallToolResult {
  return { ...result, _meta: { ...result._meta, [TOOL_PRESENTATION_META_KEY]: presentation } };
}

/**
 * The package an operation path names: the first kind segment (`agents`, `skills`,
 * `integrations`, optionally `org-` prefixed) followed by a parameter, the package id, or by two,
 * its `{scope}/{name}`. So a run under `/api/agents/{scope}/{name}/…` names its agent.
 */
const PACKAGE_IN_PATH = /\/(?:org-)?(agents|skills|integrations)\/\{([^}/]+)\}(?:\/\{([^}/]+)\})?/;
const SUBJECT_KIND = { agents: "agent", skills: "skill", integrations: "integration" } as const;

function packageSubject(pathTemplate: string, args: Record<string, unknown>) {
  const match = PACKAGE_IN_PATH.exec(pathTemplate);
  if (!match) return undefined;
  const [, segment, first, second] = match;
  const params = asRecord(args.path_params) ?? {};
  const param = (name: string | undefined) => {
    const value = name === undefined ? undefined : params[name];
    return typeof value === "string" && value ? value : undefined;
  };
  const [head, tail] = [param(first), param(second)];
  const id =
    second === undefined
      ? head
      : head && tail
        ? `${head.startsWith("@") ? "" : "@"}${head}/${tail}`
        : undefined;
  if (!id) return undefined;
  return {
    kind: SUBJECT_KIND[segment as keyof typeof SUBJECT_KIND],
    id,
  } satisfies PresentationSubject;
}

/** `invoke_operation`: the operation's tag, method and the package its path aims at, failed or not. */
function presentOperation(args: Record<string, unknown>): ToolPresentation | undefined {
  const op =
    typeof args.operation_id === "string"
      ? getCatalog().operations.get(args.operation_id)
      : undefined;
  if (!op) return undefined;
  const tag = op.tags[0];
  const subject = packageSubject(op.pathTemplate, args);
  return {
    call: "operation",
    ...(tag ? { tag } : {}),
    method: op.method,
    ...(subject ? { subject } : {}),
  };
}

/** `get_me`: the caller it answered for (`/api/me/context`, relayed as `{ status, body }`). */
function presentCaller(result: CallToolResult): ToolPresentation | undefined {
  const user = asRecord(asRecord(asRecord(unwrapMcpResult(result))?.body)?.user);
  if (!user || typeof user.id !== "string" || !user.id) return undefined;
  const name = typeof user.name === "string" && user.name ? user.name : undefined;
  return {
    call: "caller",
    subject: { kind: "user", id: user.id, ...(name ? { display_name: name } : {}) },
  };
}

function withIcons(descriptor: Tool): Tool {
  const icons = toolIcons(descriptor.name);
  return icons ? { ...descriptor, icons } : descriptor;
}

/** A handler's throw as a tool refusal: a generic sentence and the request id, the detail in the log only. */
function thrownResult(requestId: string): CallToolResult {
  return jsonResult(
    {
      code: "internal_error",
      error:
        "The tool failed unexpectedly. Retrying may work; if it persists, report the request_id.",
      request_id: requestId,
    },
    true,
  );
}

type Presenter = (
  args: Record<string, unknown>,
  result: CallToolResult,
) => ToolPresentation | undefined;

const PRESENTERS = {
  invoke_operation: (args) => presentOperation(args),
  get_me: (_args, result) => presentCaller(result),
} satisfies Partial<Record<McpToolName, Presenter>>;

const presenterOf = (name: string): Presenter | undefined =>
  Object.hasOwn(PRESENTERS, name) ? PRESENTERS[name as keyof typeof PRESENTERS] : undefined;

/**
 * Every tool given its icons, and its results their presentation unless the handler stamped one
 * (`search`, `call_integration_tool`). A handler's throw, its call not cancelled, answers a failed
 * result (`internal_error`, the request id; the detail goes to the log) presented the same way rather than a JSON-RPC error.
 */
export function presentTools(
  tools: AppstrateToolDefinition[],
  requestId: string,
): AppstrateToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    descriptor: withIcons(tool.descriptor),
    handler: async (args, extra) => {
      let result: CallToolResult;
      try {
        result = await tool.handler(args, extra);
      } catch (err) {
        if (extra.signal?.aborted) throw err;
        logger.error("mcp: tool handler threw", {
          tool: tool.descriptor.name,
          requestId,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        });
        result = thrownResult(requestId);
      }
      if (result._meta?.[TOOL_PRESENTATION_META_KEY] !== undefined) return result;
      const presentation = presenterOf(tool.descriptor.name)?.(args, result);
      return presentation ? withPresentation(result, presentation) : result;
    },
  }));
}
