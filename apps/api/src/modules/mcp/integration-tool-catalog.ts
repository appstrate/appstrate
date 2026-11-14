// SPDX-License-Identifier: Apache-2.0

/**
 * The integration tools of the caller, read from the proxy's listing route
 * (`GET /api/credential-proxy/tools`, `services/credential-proxy/integration-tools.ts`), which
 * names each tool, describes it and lists the connections it reaches. Each tool is given here how
 * the MCP tool calls it: an `api_call` tool as a batch of proxy requests (`api-call-batch.ts`), a
 * typed tool through `/api/credential-proxy/tools/call`.
 */

import type { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateRequestExtra } from "@appstrate/mcp-transport";
import { RUN_CONNECT_OFFERS_HEADER } from "@appstrate/core/run-and-wait-client";
import type {
  IntegrationToolListing,
  IntegrationTool as ListedIntegrationTool,
  ToolConnection,
} from "../../services/credential-proxy/integration-tools.ts";
import {
  API_CALL_DESCRIPTION,
  API_CALL_INPUT_SCHEMA,
  API_CALL_USAGE,
  apiCallSchema,
  BATCH_DEADLINE_MS,
  executeApiCall,
  MAX_RESULT_BYTES,
  utf8Head,
  type ApiCallArguments,
  type DispatchContext,
  type ToolCallOutcome,
} from "./api-call-batch.ts";
import { INTEGRATION_TOOLS_PATH, REMOTE_TOOLS_CALL_PATH } from "./catalog.ts";
import { asRecord, dispatchHeaders, jsonResult, type Refusal } from "./tool-results.ts";

/** One tool of an integration the caller holds a connection of, ready to call. */
export interface IntegrationTool {
  /** The name `call_integration_tool` takes. */
  name: string;
  /** The integration package id (`@scope/name`). */
  integration: string;
  /** What the tool does, as a search lists it. */
  description: string;
  /** A remote tool whose server could not be listed: named only, without description or schema. */
  catalogUnreadable?: true;
  /** How to call it and read its result, carried with its `input_schema` by `best_match`. */
  usage: string;
  /**
   * Its arguments, which `call_integration_tool` validates `arguments` against before `execute`;
   * absent for a typed tool, whose server validates them.
   */
  schema?: z.ZodType;
  /** Its arguments as JSON Schema: the `input_schema` of `best_match`. */
  inputSchema: Record<string, unknown>;
  /** A typed tool's declared result schema: the `output_schema` of `best_match`. */
  outputSchema?: Record<string, unknown>;
  /** The connections it reaches. */
  connections: ToolConnection[];
  /** Runs a call whose arguments `schema` accepted, with the connection the caller named. */
  execute(
    args: unknown,
    extra: AppstrateRequestExtra,
    connectionId: string | undefined,
  ): Promise<ToolCallOutcome | Refusal>;
}

/** A listing entry about an integration, named as the MCP tools name it (`integration`). */
type AboutIntegration<T extends { integration_package_id: string }> = Omit<
  T,
  "integration_package_id"
> & { integration: string };

export interface IntegrationTools {
  tools: IntegrationTool[];
  not_ready: AboutIntegration<IntegrationToolListing["not_ready"][number]>[];
  unlisted: AboutIntegration<IntegrationToolListing["unlisted"][number]>[];
  truncated_catalogs: AboutIntegration<IntegrationToolListing["truncated_catalogs"][number]>[];
}

/** `entry` with its `integration_package_id` named `integration`. */
function aboutIntegration<T extends { integration_package_id: string }>({
  integration_package_id,
  ...rest
}: T): AboutIntegration<T> {
  return { integration: integration_package_id, ...rest };
}

/** The listing route's refusal, as `invoke_operation` would relay it. */
export interface ListingRefusal {
  status: number;
  body: unknown;
}

/** What every tool's `usage` says of its `connections`. */
const CONNECTIONS_USAGE =
  "Its `connections`: with `credential-proxy:call`, yours and those other members shared into " +
  "the space (`owned_by_actor: false`); with `credential-proxy:call-own` alone, yours only. " +
  "Each has the `connection_id` to pass, the `authorized_uris` a target must match (unless " +
  "`allow_all_uris`; an entry may hold a `{$credential.<field>}` the proxy alone resolves), " +
  "its `scopes_granted`, and what a call passing that `connection_id` would still refuse: on a " +
  "typed tool `missing_scopes` (the scopes its policy requires that the connection lacks: the " +
  "call answers `insufficient_scopes`), and `needs_reconnection` and " +
  "`call_permission_required` (an enforced organization default governs the integration and " +
  "you hold `credential-proxy:call-own` alone). With no `connection_id` and " +
  "`credential-proxy:call` held, an organization default applies first. A connection you do " +
  "not own is used when you pass its `connection_id` or an organization default designates it.";

const REMOTE_TOOL_USAGE =
  "Pass the tool's own arguments in `arguments`, following its `input_schema`: the platform " +
  "checks only that the required ones are present, the server validates the rest (a refusal " +
  "of the server answers `upstream_mcp_error`, with its `mcp_error.code` and `message`). When " +
  "it has an `output_schema`, its `structuredContent` follows it. The `connection_id` of " +
  "call_integration_tool names the connection; without it the proxy chooses as for an " +
  "`api_call`, and `must_choose_connection` lists the candidates in " +
  "`errors[0].candidate_connections` (retry with one `id` as `connection_id`). The result is " +
  `the server's own tool result, relayed as is up to ${MAX_RESULT_BYTES} bytes; past that the ` +
  "tool has run: a text block that does not fit whole is cut, any other block that does not " +
  'fit is replaced by a note, and `_meta["dev.appstrate/truncated"]` is `true`. An error ' +
  "result carrying `content` is the tool's own failure (`isError: true`); one carrying `code`, " +
  "`status` and `detail` is the platform's answer: a refusal before anything was sent, or the " +
  "server failing the exchange: `bad_gateway`, `upstream_mcp_error`, `upstream_timeout` (no " +
  "answer in time: the tool may have run, check before repeating a write), " +
  "`upstream_response_too_large` (the tool ran but its answer exceeds the exchange bound: ask " +
  "it for less), or `upstream_credential_rejected` (the server refused the connection's " +
  "credential with HTTP `upstream_status`; do not retry: with `credential.status` " +
  "`needs_reconnection`, its owner must reconnect it, otherwise the connection may lack a " +
  "permission the tool needs; tell the user). " +
  CONNECTIONS_USAGE;

/** Appended to a text block cut at the result budget. */
const cutMarker = (kept: number, total: number) =>
  `\n[cut: ${kept} of ${total} bytes kept, over the ${MAX_RESULT_BYTES}-byte result budget]`;

/**
 * A tool result over {@link MAX_RESULT_BYTES}, bounded: its content blocks kept in order while
 * they fit, the first text block that does not fit cut to what is left (on a character boundary,
 * marked), any other block that does not fit replaced by a note, `structuredContent` kept only if
 * it still fits. The call has run: nothing of what fits is dropped.
 */
function boundedResult(result: CallToolResult): CallToolResult {
  const encoder = new TextEncoder();
  const size = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
  let budget = MAX_RESULT_BYTES;
  let cut = 0;
  let omitted = 0;
  const content = (Array.isArray(result.content) ? result.content : []).map((block, index) => {
    const bytes = size(block);
    if (bytes <= budget) {
      budget -= bytes;
      return block;
    }
    if (block.type === "text" && budget > 0) {
      const text = encoder.encode(block.text);
      const head = utf8Head(text, budget, false);
      budget -= head.keptBytes;
      cut += 1;
      return { ...block, text: head.text + cutMarker(head.keptBytes, text.byteLength) };
    }
    omitted += 1;
    return {
      type: "text" as const,
      text: `[content block ${index} omitted: ${bytes} bytes, over the ${MAX_RESULT_BYTES}-byte result budget]`,
    };
  });
  const structured =
    result.structuredContent !== undefined && size(result.structuredContent) <= budget
      ? { structuredContent: result.structuredContent }
      : {};
  const droppedStructured =
    result.structuredContent !== undefined && !("structuredContent" in structured);
  content.push({
    type: "text",
    text:
      `The tool ran; its result exceeds ${MAX_RESULT_BYTES} bytes: ${cut} text block(s) cut, ` +
      `${omitted} other block(s)${droppedStructured ? " and its structuredContent" : ""} ` +
      "dropped, the rest is as it answered.",
  });
  return {
    content,
    ...structured,
    ...(result.isError ? { isError: true } : {}),
    _meta: { "dev.appstrate/truncated": true },
  };
}

/**
 * The headers of a request to the proxy's tool routes. It asks for connect links: the MCP client
 * hands a refusal's `connect_url` to the human driving it, as `run_and_wait` does (see
 * `RUN_CONNECT_OFFERS_HEADER`).
 */
function toolRouteHeaders(ctx: DispatchContext, contentType?: string): Headers {
  return dispatchHeaders(
    ctx.authHeaders,
    new Headers({
      [RUN_CONNECT_OFFERS_HEADER]: "1",
      ...(contentType ? { "Content-Type": contentType } : {}),
    }),
  );
}

/** One `tools/call` through the proxy's tool route; its refusal comes back as is. */
async function executeRemoteTool(
  ctx: DispatchContext,
  integrationId: string,
  name: string,
  args: Record<string, unknown>,
  extra: AppstrateRequestExtra,
  connectionId: string | undefined,
): Promise<ToolCallOutcome> {
  const response = await ctx.dispatch(
    new Request(new URL(REMOTE_TOOLS_CALL_PATH, ctx.origin).toString(), {
      method: "POST",
      headers: toolRouteHeaders(ctx, "application/json"),
      body: JSON.stringify({
        integration_package_id: integrationId,
        ...(connectionId ? { connection_id: connectionId } : {}),
        name,
        arguments: args,
      }),
      ...(extra.signal ? { signal: extra.signal } : {}),
    }),
  );
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const body = asRecord(parsed);
  const result = asRecord(body?.result);
  if (!response.ok || !result) {
    return { result: jsonResult(body ?? { status: response.status }, true), shownCount: 0 };
  }
  if (new TextEncoder().encode(text).byteLength > MAX_RESULT_BYTES) {
    return { result: boundedResult(result as CallToolResult), shownCount: 1 };
  }
  return { result: result as CallToolResult, shownCount: 1 };
}

/** A listed tool with how the MCP tool calls it. */
function callable(ctx: DispatchContext, tool: ListedIntegrationTool): IntegrationTool {
  const base = {
    name: tool.name,
    integration: tool.integration_package_id,
    connections: tool.connections,
  };
  if (tool.kind === "api_call") {
    const target = { ...base, connectionRequired: tool.connection_required };
    return {
      ...base,
      description: `${tool.description} ${API_CALL_DESCRIPTION}`,
      usage: `${API_CALL_USAGE} ${CONNECTIONS_USAGE}`,
      schema: apiCallSchema,
      inputSchema: API_CALL_INPUT_SCHEMA,
      execute: (args, extra, named) =>
        executeApiCall(ctx, target, args as ApiCallArguments, extra, {
          defaultConnectionId: named,
          deadlineMs: BATCH_DEADLINE_MS,
        }),
    };
  }
  return {
    ...base,
    description: tool.description,
    ...(tool.catalog_unreadable ? { catalogUnreadable: true as const } : {}),
    usage: REMOTE_TOOL_USAGE,
    inputSchema: tool.input_schema,
    ...(tool.output_schema ? { outputSchema: tool.output_schema } : {}),
    execute: (args, extra, named) =>
      executeRemoteTool(
        ctx,
        tool.integration_package_id,
        tool.remote_name,
        args as Record<string, unknown>,
        extra,
        named,
      ),
  };
}

/**
 * The caller's integration tools, from the listing route, filtered by its query parameters
 * (`integration_package_id`, `name`, `connection_id`). The route's refusal comes back as is.
 */
export async function readIntegrationTools(
  ctx: DispatchContext,
  query: { integration?: string; name?: string; connectionId?: string },
): Promise<IntegrationTools | { refused: ListingRefusal }> {
  const url = new URL(INTEGRATION_TOOLS_PATH, ctx.origin);
  if (query.integration !== undefined) {
    url.searchParams.set("integration_package_id", query.integration);
  }
  if (query.name !== undefined) url.searchParams.set("name", query.name);
  if (query.connectionId !== undefined) url.searchParams.set("connection_id", query.connectionId);
  const response = await ctx.dispatch(
    new Request(url.toString(), { method: "GET", headers: toolRouteHeaders(ctx) }),
  );
  const body = asRecord(await response.json().catch(() => undefined));
  if (!response.ok || !Array.isArray(body?.tools)) {
    return { refused: { status: response.status, body: body ?? null } };
  }
  const listing = body as unknown as IntegrationToolListing;
  return {
    tools: listing.tools.map((tool) => callable(ctx, tool)),
    not_ready: listing.not_ready.map(aboutIntegration),
    unlisted: listing.unlisted.map(aboutIntegration),
    truncated_catalogs: listing.truncated_catalogs.map(aboutIntegration),
  };
}
