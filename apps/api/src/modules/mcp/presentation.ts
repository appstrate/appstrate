// SPDX-License-Identifier: Apache-2.0

/**
 * The presentation stamped on every result of the platform's MCP tools
 * (`@appstrate/core/mcp-presentation`): what the call did and to what, so a client draws it
 * without guessing from a tool name.
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
import type { McpToolName } from "./tools.ts";

/** `result` with `presentation` stamped, replacing any stamp it carried. */
export function withPresentation(
  result: CallToolResult,
  presentation: ToolPresentation,
): CallToolResult {
  return { ...result, _meta: { ...result._meta, [TOOL_PRESENTATION_META_KEY]: presentation } };
}

/** The presentation a descriptor implies: its display name (MCP: `title`, `annotations.title`, `name`). */
function descriptorPresentation(descriptor: Tool): ToolPresentation {
  return { title: descriptor.title ?? descriptor.annotations?.title ?? descriptor.name };
}

/**
 * The first package an operation path names: its kind's segment (`agents`, `skills`,
 * `integrations`, `org-integrations`) and the parameters right after it, one package id
 * (`{packageId}`, `{integrationPackageId}`) or `{scope}/{name}`. A run's or a schedule's
 * operation under `/api/agents/{scope}/{name}/…` names its agent this way; a path naming no
 * package by kind (`/api/runs/{id}`, `/api/packages/{scope}/{name}`) has no subject.
 */
const PACKAGE_IN_PATH = /\/(?:org-)?(agents|skills|integrations)\/\{([^}/]+)\}(?:\/\{([^}/]+)\})?/;
const SUBJECT_KIND = { agents: "agent", skills: "skill", integrations: "integration" } as const;

/** The agent, skill or integration an operation's path names, with the id its arguments give it. */
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

/**
 * The tools that know more than their descriptor once a call returns, keyed by
 * {@link McpToolName}: a key no tool is named fails to typecheck.
 */
const PRESENTERS = {
  invoke_operation: (_descriptor, args) => presentOperation(args),
  get_me: (descriptor, _args, result) => presentCaller(descriptor, result),
} satisfies Partial<Record<McpToolName, Presenter>>;

const presenterOf = (name: string): Presenter | undefined =>
  Object.hasOwn(PRESENTERS, name) ? PRESENTERS[name as keyof typeof PRESENTERS] : undefined;

/** Every tool's results stamped with their presentation, and its descriptor given its icons. */
export function presentTools(tools: AppstrateToolDefinition[]): AppstrateToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    descriptor: withIcons(tool.descriptor),
    handler: async (args, extra) => {
      const result = await tool.handler(args, extra);
      if (result._meta?.[TOOL_PRESENTATION_META_KEY] !== undefined) return result;
      const presentation =
        presenterOf(tool.descriptor.name)?.(tool.descriptor, args, result) ??
        descriptorPresentation(tool.descriptor);
      return withPresentation(result, presentation);
    },
  }));
}
