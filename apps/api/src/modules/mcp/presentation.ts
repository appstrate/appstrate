// SPDX-License-Identifier: Apache-2.0

/**
 * The presentation stamped on every tool result (`@appstrate/core/mcp-presentation`): what the
 * call did, to what, and whether it wrote, so a client draws it without guessing from a tool name.
 * {@link presentTools} stamps every tool's results once, at the edge of the tool list: a tool that
 * knows more than its descriptor states it here, from its arguments and result, or in its handler
 * (`search` and `call_integration_tool`, which alone hold the integrations they read). Whatever a
 * handler stamps wins, and a result nothing describes gets its descriptor's title and hints.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";
import {
  isReadOnlyMethod,
  TOOL_LOOKUP_META_KEY,
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

/**
 * The presentation a descriptor implies: its title and MCP hints. `destructiveHint` counts only
 * when stated on a tool that writes; MCP's default (`true`) would mark every unknown tool.
 */
export function descriptorPresentation(descriptor: Tool): ToolPresentation {
  const hints = descriptor.annotations;
  const readOnly = hints?.readOnlyHint === true;
  return {
    title: hints?.title ?? descriptor.title ?? descriptor.name,
    read_only: readOnly,
    destructive: !readOnly && hints?.destructiveHint === true,
  };
}

/** The tag of an operation whose package path parameter names an agent or an integration. */
const SUBJECT_KIND_BY_TAG: Record<string, PresentationSubject["kind"]> = {
  Agents: "agent",
  Integrations: "integration",
};

/** The package an operation's path parameters name (`packageId`, or `scope` and `name`). */
function packageSubject(tag: string | undefined, args: Record<string, unknown>) {
  const params = asRecord(args.path_params) ?? {};
  const id =
    typeof params.packageId === "string"
      ? params.packageId
      : typeof params.scope === "string" && typeof params.name === "string"
        ? `${params.scope.startsWith("@") ? "" : "@"}${params.scope}/${params.name}`
        : undefined;
  if (!id) return undefined;
  const kind = (tag === undefined ? undefined : SUBJECT_KIND_BY_TAG[tag]) ?? "package";
  return { kind, id } satisfies PresentationSubject;
}

/** `invoke_operation`: the OpenAPI operation named, its method deciding whether it wrote. */
function presentOperation(args: Record<string, unknown>): ToolPresentation | undefined {
  const op =
    typeof args.operation_id === "string"
      ? getCatalog().operations.get(args.operation_id)
      : undefined;
  if (!op) return undefined;
  const tag = op.tags[0];
  const subject = packageSubject(tag, args);
  return {
    title: op.summary || op.operationId,
    read_only: isReadOnlyMethod(op.method),
    destructive: op.method === "DELETE",
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

/**
 * Tools that only look things up although MCP's `readOnlyHint` is withheld: with the kind of
 * integration tools, `search` and `describe` may read a third-party catalog, which journals a
 * call and can refresh a token, but they change nothing of the caller's.
 */
const LOOKUP_TOOLS: ReadonlySet<string> = new Set(["search", "describe"]);

/** `descriptor` as a client draws it: its icons, unless it declares its own, and the lookup stamp. */
function presentDescriptor(descriptor: Tool): Tool {
  const icons = descriptor.icons ? undefined : toolIcons(descriptor.name);
  const lookup = LOOKUP_TOOLS.has(descriptor.name);
  if (!icons && !lookup) return descriptor;
  return {
    ...descriptor,
    ...(icons ? { icons } : {}),
    ...(lookup ? { _meta: { ...descriptor._meta, [TOOL_LOOKUP_META_KEY]: true } } : {}),
  };
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

/** Every tool's results stamped with their presentation, and its descriptor as a client draws it. */
export function presentTools(tools: AppstrateToolDefinition[]): AppstrateToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    descriptor: presentDescriptor(tool.descriptor),
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
