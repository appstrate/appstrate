// SPDX-License-Identifier: Apache-2.0

/**
 * The presentation stamped on every tool result (`@appstrate/core/mcp-presentation`): what the
 * call did and to what, so a client draws it without guessing from a tool name.
 * {@link presentTools} stamps every tool's results once, at the edge of the tool list: a tool that
 * knows more than its descriptor states it here, from its arguments and result, or in its handler
 * (`search` and `call_integration_tool`, which alone hold the integrations they read). Whatever a
 * handler stamps wins, and a result nothing describes gets its descriptor's title.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";
import {
  TOOL_PRESENTATION_META_KEY,
  type PresentationSubject,
  type ToolPresentation,
} from "@appstrate/core/mcp-presentation";
import { asRecord } from "@appstrate/core/safe-json";
import { unwrapMcpResult } from "@appstrate/core/mcp-result";
import { getCatalog } from "./catalog.ts";
import { toolIcons } from "./tool-icons.ts";

/** `result` with `presentation` stamped, replacing any stamp it carried. */
export function withPresentation(
  result: CallToolResult,
  presentation: ToolPresentation,
): CallToolResult {
  return { ...result, _meta: { ...result._meta, [TOOL_PRESENTATION_META_KEY]: presentation } };
}

/** The presentation a descriptor implies: its display name (MCP: `title`, `annotations.title`, `name`). */
export function descriptorPresentation(descriptor: Tool): ToolPresentation {
  return { title: descriptor.title ?? descriptor.annotations?.title ?? descriptor.name };
}

/** The package kind an operation path names (`/api/agents/{…}`, `/api/packages/skills/{…}`, …). */
const SUBJECT_KIND_IN_PATH = /\/(?:org-)?(agents|skills|integrations)\/\{/;
const SUBJECT_KIND = { agents: "agent", skills: "skill", integrations: "integration" } as const;

/** The agent, skill or integration an operation's path parameters name (`packageId`, or `scope` and `name`). */
function packageSubject(pathTemplate: string, args: Record<string, unknown>) {
  const segment = SUBJECT_KIND_IN_PATH.exec(pathTemplate)?.[1] as
    keyof typeof SUBJECT_KIND | undefined;
  if (!segment) return undefined;
  const params = asRecord(args.path_params) ?? {};
  const id =
    typeof params.packageId === "string"
      ? params.packageId
      : typeof params.scope === "string" && typeof params.name === "string"
        ? `${params.scope.startsWith("@") ? "" : "@"}${params.scope}/${params.name}`
        : undefined;
  return id ? ({ kind: SUBJECT_KIND[segment], id } satisfies PresentationSubject) : undefined;
}

/** `invoke_operation`: the OpenAPI operation named. */
function presentOperation(args: Record<string, unknown>): ToolPresentation | undefined {
  const op =
    typeof args.operation_id === "string"
      ? getCatalog().operations.get(args.operation_id)
      : undefined;
  if (!op) return undefined;
  const tag = op.tags[0];
  const subject = packageSubject(op.pathTemplate, args);
  return {
    title: op.summary || op.operationId,
    ...(tag ? { tag } : {}),
    method: op.method,
    ...(subject ? { subject } : {}),
  };
}

/** `get_me`: the caller it answered for (`/api/me/context`, relayed as `{ status, body }`). */
function presentCaller(descriptor: Tool, result: CallToolResult): ToolPresentation | undefined {
  const user = asRecord(asRecord(asRecord(unwrapMcpResult(result))?.body)?.user);
  if (!user || typeof user.id !== "string") return undefined;
  const name = typeof user.name === "string" && user.name ? user.name : undefined;
  return {
    ...descriptorPresentation(descriptor),
    subject: { kind: "user", id: user.id, ...(name ? { display_name: name } : {}) },
  };
}

/** `descriptor` with its icons, unless it declares its own. */
function withIcons(descriptor: Tool): Tool {
  const icons = descriptor.icons ? undefined : toolIcons(descriptor.name);
  return icons ? { ...descriptor, icons } : descriptor;
}

type Presenter = (
  descriptor: Tool,
  args: Record<string, unknown>,
  result: CallToolResult,
) => ToolPresentation | undefined;

const PRESENTERS: Partial<Record<string, Presenter>> = {
  invoke_operation: (_descriptor, args) => presentOperation(args),
  get_me: (descriptor, _args, result) => presentCaller(descriptor, result),
};

/** Every tool's results stamped with their presentation, and its descriptor given its icons. */
export function presentTools(tools: AppstrateToolDefinition[]): AppstrateToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    descriptor: withIcons(tool.descriptor),
    handler: async (args, extra) => {
      const result = await tool.handler(args, extra);
      if (result._meta?.[TOOL_PRESENTATION_META_KEY] !== undefined) return result;
      const presentation =
        PRESENTERS[tool.descriptor.name]?.(tool.descriptor, args, result) ??
        descriptorPresentation(tool.descriptor);
      return withPresentation(result, presentation);
    },
  }));
}
