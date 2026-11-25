// SPDX-License-Identifier: Apache-2.0

/**
 * The integration tools of the caller, read from the proxy's listing route
 * (`GET /api/credential-proxy/tools`, `services/credential-proxy/integration-tools.ts`), which
 * names each tool, describes it and lists the connections it reaches. Each tool is given here how
 * the MCP tool calls it: an `api_call` tool as a batch of proxy requests (`api-call-batch.ts`), a
 * typed tool through `/api/credential-proxy/tools/call`.
 */

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { proxyConnectionVerdictProperties } from "../../openapi/paths/integrations.ts";
import {
  TOOL_DESCRIPTOR_REDUCTIONS,
  markRelayedResult,
  type AppstrateRequestExtra,
} from "@appstrate/mcp-transport";
import { RUN_CONNECT_OFFERS_HEADER } from "@appstrate/core/run-and-wait-client";
import type {
  IntegrationTool,
  IntegrationToolListing,
} from "../../services/credential-proxy/integration-tools.ts";
import {
  API_CALL_DESCRIPTION,
  API_CALL_INPUT_SCHEMA,
  API_CALL_USAGE,
  apiCallSchema,
  executeApiCall,
  jsonTextHead,
  MAX_RESULT_BYTES,
  type ApiCallArguments,
  type DispatchContext,
  type ToolCallOutcome,
} from "./api-call-batch.ts";
import { INTEGRATION_TOOLS_PATH, REMOTE_TOOLS_CALL_PATH } from "./catalog.ts";
import {
  asRecord,
  dispatchHeaders,
  jsonResult,
  type Refusal,
  type RouteRefusal,
} from "./tool-results.ts";

/** A tool of the listing, as the route returns it, with how `call_integration_tool` calls it. */
export type CallableTool = IntegrationTool & {
  /** How to call it and read its result, carried with its `input_schema` by `describe`. */
  usage: string;
  /** Its arguments as JSON Schema. */
  input_schema: Record<string, unknown>;
  /**
   * Its arguments, which `call_integration_tool` validates `arguments` against before `execute`;
   * absent for a typed tool, whose server validates them.
   */
  schema?: z.ZodType;
  /** Runs a call whose arguments `schema` accepted, with the connection the caller named. */
  execute(
    args: unknown,
    extra: AppstrateRequestExtra,
    connectionId: string | undefined,
  ): Promise<ToolCallOutcome | Refusal>;
};

export type CallableListing = Omit<IntegrationToolListing, "tools"> & { tools: CallableTool[] };

/** Scopes of a connection a search lists; past it `scopes_granted_count` gives the total. */
export const MAX_LISTED_SCOPES = 20;

/**
 * What a tool's `usage` says of its connections. `missing_scopes` is the tool's own field, carried
 * by typed tools alone.
 */
function connectionsUsage(typed: boolean): string {
  return (
    "Its `connection_ids` name, among the result's `connections`, those it reaches: with " +
    "`credential-proxy:call`, yours and those other members shared into the space " +
    "(`owned_by_actor: false`); with `credential-proxy:call-own` alone, yours only. Each " +
    "connection has the `connection_id` to pass, the `authorized_uris` a target must match " +
    "(unless `allow_all_uris`; an entry may hold a `{$credential.<field>}` the proxy alone " +
    `resolves), its \`scopes_granted\` (the first ${MAX_LISTED_SCOPES}, \`scopes_granted_count\` ` +
    "giving the total when it is longer: the full list is in the entry of " +
    "`listCredentialProxyConnections`, through invoke_operation), and what a call passing that " +
    "`connection_id` would still refuse: " +
    (typed
      ? "the tool's `missing_scopes` maps a connection id to the scopes its policy requires " +
        "that the connection lacks (the call answers `insufficient_scopes`), "
      : "") +
    "`needs_reconnection` and " +
    "`call_permission_required` (an enforced organization default governs the integration and " +
    "you hold `credential-proxy:call-own` alone). With no `connection_id` and " +
    "`credential-proxy:call` held, an organization default applies first. A connection you do " +
    "not own is used when you pass its `connection_id` or an organization default designates it."
  );
}

const REMOTE_TOOL_USAGE =
  "Pass the tool's own arguments in `arguments`, following its `input_schema`: the platform " +
  "checks that the required ones are present and, when the schema closes its properties " +
  "(`additionalProperties: false`), that no key is unknown (`unknown_argument`); the server " +
  "validates the rest. A server may refuse the call with a protocol error (the platform's " +
  "`upstream_invalid_params` for its arguments or tool name, else `upstream_mcp_error`, " +
  "either with its `mcp_error.code` and `message`) or with its own `isError` tool result. When " +
  "it has an `output_schema`, its `structuredContent` follows it. A `schema_reduced` lists " +
  "what was cut from the server's schemas to fit the size bound: `output_schema` (none " +
  "shown), `schema_documentation` (descriptions, titles, examples and annotations dropped), " +
  "`input_schema` (arguments not shown; the server validates them). The `connection_id` of " +
  "call_integration_tool names the connection; without it the proxy chooses as for an " +
  "`api_call`, and `must_choose_connection` lists the candidates in " +
  "`errors[0].candidate_connections` (retry with one `id` as `connection_id`); a tool whose " +
  "`connection_ids` is empty belongs to an integration that binds no connection, and is " +
  "called without `connection_id`. The result is the server's own tool result, relayed as " +
  `is up to ${MAX_RESULT_BYTES} bytes; past that the ` +
  "tool has run: a text block that does not fit whole is cut, any other block that does not " +
  "fit is replaced by a note while one fits, a closing note counts what was cut or dropped, " +
  'and `_meta["dev.appstrate/truncated"]` is `true`. Such a result, the server\'s, carries ' +
  '`_meta["dev.appstrate/relayed"]: true`; the platform\'s own answers never do. An error ' +
  "result carrying `content` is the tool's own failure (`isError: true`); one carrying `code`, " +
  "`status` and `detail` is the platform's answer: a refusal before anything was sent, or the " +
  "server failing the exchange: `bad_gateway`, `upstream_invalid_params`, `upstream_mcp_error`, " +
  "`upstream_timeout` (no " +
  "answer in time: the tool may have run, check before repeating a write), " +
  "`upstream_response_too_large` (the tool ran but its answer exceeds the exchange bound: ask " +
  "it for less), or `upstream_credential_rejected` (the server refused the connection's " +
  "credential with HTTP `upstream_status`; do not retry: with `credential.status` " +
  "`needs_reconnection`, its owner must reconnect it, otherwise the connection may lack a " +
  "permission the tool needs; tell the user). " +
  connectionsUsage(true);

/** Appended to a text block cut at the result budget. */
const cutMarker = (kept: number, total: number) =>
  `\n[cut: ${kept} of ${total} bytes kept, over the ${MAX_RESULT_BYTES}-byte result budget]`;

/** The closing note of a bounded result. */
const truncationNote = (cut: number, omitted: number, droppedStructured: boolean) =>
  `The tool ran; its result exceeds ${MAX_RESULT_BYTES} bytes: ${cut} text block(s) cut, ` +
  `${omitted} other block(s)${droppedStructured ? " and its structuredContent" : ""} ` +
  "dropped, the rest is as it answered.";

/** A bounded result's `_meta`: cut, and relayed — only a server's own result is ever bounded. */
const BOUNDED_META = markRelayedResult({ _meta: { "dev.appstrate/truncated": true } })._meta;

/**
 * A tool result over {@link MAX_RESULT_BYTES}, bounded so that its JSON is at most that many
 * bytes: its content blocks kept in order while they fit, the first text block that does not fit
 * cut to what is left (its text alone, on a character boundary, marked), any other block that does
 * not fit replaced by a note while one fits, `structuredContent` kept only if it still fits, and a
 * closing note counting what was cut or dropped. The call has run: nothing of what fits is
 * dropped.
 */
function boundedResult(result: CallToolResult): CallToolResult {
  const encoder = new TextEncoder();
  const size = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
  const blocks = Array.isArray(result.content) ? result.content : [];
  const isError = result.isError ? { isError: true as const } : {};
  // The result with no block but the closing note, its counts at their widest.
  const frame = size({
    content: [{ type: "text", text: truncationNote(blocks.length, blocks.length, true) }],
    ...isError,
    _meta: BOUNDED_META,
  });
  // Each block added to the array costs its JSON and a comma.
  let budget = MAX_RESULT_BYTES - frame;
  const take = (bytes: number) => {
    if (bytes + 1 > budget) return false;
    budget -= bytes + 1;
    return true;
  };
  const emptyText = size({ type: "text", text: "" });
  let cut = 0;
  let omitted = 0;
  const content: CallToolResult["content"] = [];
  for (const [index, block] of blocks.entries()) {
    const bytes = size(block);
    if (take(bytes)) {
      content.push(block);
      continue;
    }
    if (block.type === "text") {
      const total = encoder.encode(block.text).byteLength;
      const marker = jsonTextHead(cutMarker(total, total), Infinity).jsonBytes;
      const head = jsonTextHead(block.text, budget - 1 - emptyText - marker);
      if (head.text.length > 0 && take(emptyText + head.jsonBytes + marker)) {
        cut += 1;
        content.push({
          type: "text",
          text: head.text + cutMarker(encoder.encode(head.text).byteLength, total),
        });
        continue;
      }
    }
    omitted += 1;
    const note = {
      type: "text" as const,
      text: `[content block ${index} omitted: ${bytes} bytes, over the ${MAX_RESULT_BYTES}-byte result budget]`,
    };
    if (take(size(note))) content.push(note);
  }
  const structured =
    result.structuredContent !== undefined &&
    size({ structuredContent: result.structuredContent }) - 2 + 1 <= budget
      ? { structuredContent: result.structuredContent }
      : {};
  const droppedStructured =
    result.structuredContent !== undefined && !("structuredContent" in structured);
  content.push({ type: "text", text: truncationNote(cut, omitted, droppedStructured) });
  return { content, ...structured, ...isError, _meta: BOUNDED_META };
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
  // The server's own result, marked relayed (`boundedResult` marks its own): the platform's
  // answers above are not.
  if (new TextEncoder().encode(text).byteLength > MAX_RESULT_BYTES) {
    return { result: boundedResult(result as CallToolResult), shownCount: 1 };
  }
  return { result: markRelayedResult(result as CallToolResult), shownCount: 1 };
}

/** A listed tool with how the MCP tool calls it. */
function callable(ctx: DispatchContext, tool: IntegrationTool): CallableTool {
  if (tool.kind === "api_call") {
    return {
      ...tool,
      description: `${tool.description} ${API_CALL_DESCRIPTION}`,
      usage: `${API_CALL_USAGE} ${connectionsUsage(false)}`,
      schema: apiCallSchema,
      input_schema: API_CALL_INPUT_SCHEMA,
      execute: (args, extra, named) =>
        executeApiCall(ctx, tool, args as ApiCallArguments, extra, named),
    };
  }
  return {
    ...tool,
    usage: REMOTE_TOOL_USAGE,
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

const stringList = z.array(z.string());
const toolFields = {
  name: z.string(),
  integration_package_id: z.string(),
  description: z.string(),
  connection_ids: stringList,
};
const schemaObject = z.record(z.string(), z.unknown());
const integrationListingSchema = z.looseObject({
  tools: z.array(
    z.discriminatedUnion("kind", [
      z.looseObject({
        ...toolFields,
        kind: z.literal("api_call"),
        auth_key: z.string(),
        connection_required: z.boolean(),
      }),
      z.looseObject({
        ...toolFields,
        kind: z.literal("remote"),
        remote_name: z.string(),
        title: z.string().optional(),
        read_only_hint: z.literal(true).optional(),
        destructive_hint: z.literal(true).optional(),
        input_schema: schemaObject,
        output_schema: schemaObject.optional(),
        schema_reduced: z.array(z.enum(TOOL_DESCRIPTOR_REDUCTIONS)).optional(),
        catalog_unreadable: z.literal(true).optional(),
        missing_scopes: z.record(z.string(), stringList).optional(),
      }),
    ]),
  ),
  integrations: z.array(
    z.looseObject({
      integration_package_id: z.string(),
      display_name: z.string(),
      icon: z.string().optional(),
    }),
  ),
  connections: z.array(
    z.looseObject({
      integration_package_id: z.string(),
      connection_id: z.string(),
      label: z.string(),
      owned_by_actor: z.boolean(),
      auth_key: z.string(),
      scopes_granted: stringList,
      authorized_uris: stringList,
      allow_all_uris: z.boolean(),
      needs_reconnection: z.boolean(),
      call_permission_required: z.boolean(),
    }),
  ),
  not_ready: z.array(
    z.looseObject({
      integration_package_id: z.string(),
      display_name: z.string(),
      proxy_connection: z.looseObject({
        status: z.enum(proxyConnectionVerdictProperties.status.enum),
        imposed: z.boolean(),
      }),
      refusal: z
        .looseObject({ field: z.string(), code: z.string(), message: z.string() })
        .optional(),
    }),
  ),
  unlisted: z.array(
    z.looseObject({
      integration_package_id: z.string(),
      refusal: z.looseObject({
        type: z.string(),
        title: z.string(),
        status: z.number(),
        detail: z.string(),
        instance: z.string(),
        code: z.string(),
        request_id: z.string(),
      }),
    }),
  ),
  truncated_catalogs: z.array(
    z.looseObject({
      integration_package_id: z.string(),
      listed_tools: z.number().int().nonnegative(),
    }),
  ),
  uncached: stringList,
}) satisfies z.ZodType<IntegrationToolListing>;

/**
 * The caller's integration tools, from the listing route, filtered by its query parameters
 * (`integration_package_id`, `name`, `connection_id`); the MCP request's `signal` cancels it. The
 * route's refusal comes back as is.
 */
export async function readIntegrationTools(
  ctx: DispatchContext,
  query: { integration?: string; name?: string; connectionId?: string; cachedOnly?: boolean },
  signal: AbortSignal | undefined,
): Promise<CallableListing | { refused: RouteRefusal }> {
  const url = new URL(INTEGRATION_TOOLS_PATH, ctx.origin);
  if (query.integration !== undefined) {
    url.searchParams.set("integration_package_id", query.integration);
  }
  if (query.name !== undefined) url.searchParams.set("name", query.name);
  if (query.connectionId !== undefined) url.searchParams.set("connection_id", query.connectionId);
  if (query.cachedOnly) url.searchParams.set("catalogs", "cached");
  const response = await ctx.dispatch(
    new Request(url.toString(), {
      method: "GET",
      headers: toolRouteHeaders(ctx),
      ...(signal ? { signal } : {}),
    }),
  );
  const body = asRecord(await response.json().catch(() => undefined));
  if (!response.ok) {
    return { refused: { status: response.status, body: body ?? null } };
  }
  const parsed = integrationListingSchema.safeParse(body);
  if (!parsed.success)
    return {
      refused: {
        status: 502,
        body: {
          code: "invalid_integration_catalog",
          detail: "Invalid response from the integration tools catalogue",
        },
      },
    };
  const listing = parsed.data;
  return { ...listing, tools: listing.tools.map((tool) => callable(ctx, tool)) };
}
