// SPDX-License-Identifier: Apache-2.0

/**
 * `search_integration_tools` and `call_integration_tool`: the tools of the integrations the caller
 * holds a connection of, outside a run, behind two discovery tools.
 *
 * Both read the tools from the proxy's listing route (`integration-tool-catalog.ts`), which names
 * each one (`{ns}__api_call`, `{ns}__api_call__{auth}`, `{ns}__{tool}`), describes it and lists its
 * connections; here a search only filters and ranks them, and a call resolves its tool by its full
 * name and runs it. Every upstream request is dispatched in-process to
 * the proxy routes (`routes/credential-proxy.ts`), so the guard, the rate limit and the access
 * rule (`services/credential-proxy/access.ts`) are the REST door's and none is restated here.
 * Those routes are kept out of the operation catalog (`isExcludedPath`): the two tools are the one
 * MCP path to them, with typed arguments where `/proxy` takes control headers and a bounded result
 * where it relays the upstream body.
 */

import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateRequestExtra, AppstrateToolDefinition } from "@appstrate/mcp-transport";
import { renderFieldPath } from "@appstrate/core/api-errors";
import type { DispatchContext } from "./api-call-batch.ts";
import { INTEGRATION_TOOLS_PATH } from "./catalog.ts";
import {
  readIntegrationTools,
  type IntegrationTool,
  type ListingRefusal,
} from "./integration-tool-catalog.ts";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  rankByKeywords,
  searchLimit,
  searchScore,
  searchTokens,
} from "./search.ts";
import { jsonResult, refusalResult, type Refusal } from "./tool-results.ts";
import type { McpObserver, McpToolName } from "./tools.ts";

interface IntegrationToolContext extends DispatchContext {
  observe: McpObserver;
  /** The caller is also offered `run_and_wait`, so the descriptions may name it. */
  runs: boolean;
}

/** Issues one argument refusal names. */
const MAX_REPORTED_ISSUES = 10;

/** The refusal of a parse; `prefix` places the parsed object among the tool's arguments. */
function argumentsRefusal(error: z.ZodError, prefix: PropertyKey[] = []): Refusal {
  const path = (issuePath: PropertyKey[]) => renderFieldPath([...prefix, ...issuePath]);
  const unknown = error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys" ? issue.keys.map((key) => path([...issue.path, key])) : [],
  );
  if (unknown.length > 0) {
    return {
      code: "unknown_argument",
      error: `Unknown argument(s): ${unknown.join(", ")}.`,
      arguments: unknown,
    };
  }
  const issues = error.issues.slice(0, MAX_REPORTED_ISSUES);
  return {
    code: "invalid_argument",
    error: issues.map((issue) => `${path(issue.path)}: ${issue.message}`).join("; "),
    arguments: [...new Set(issues.map((issue) => path(issue.path)))],
  };
}

/** The listing route's refusal, as `invoke_operation` would relay it. */
function listingRefused(
  ctx: IntegrationToolContext,
  tool: McpToolName,
  start: number,
  refused: ListingRefusal,
): CallToolResult {
  ctx.observe({
    tool,
    durationMs: performance.now() - start,
    method: "GET",
    path: INTEGRATION_TOOLS_PATH,
    status: refused.status,
    outcome: "invoked",
  });
  return jsonResult({ ...refused }, true);
}

/** A tool as a search lists it. */
function listedTool(tool: IntegrationTool): Record<string, unknown> {
  return {
    tool: tool.name,
    integration: tool.integration,
    description: tool.description,
    ...(tool.catalogUnreadable ? { catalog_unreadable: true } : {}),
    connections: tool.connections,
  };
}

function buildSearchIntegrationToolsTool(ctx: IntegrationToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "search_integration_tools",
    description:
      "Search the tools of the integrations you hold a connection of in this space, by keyword " +
      "and/or integration; with neither, list them, `limit` at a time. They are each " +
      "integration's `api_call` tools and, for an integration backed by a remote MCP server, " +
      "the typed tools that server offers. Each result has the `tool` name to pass to " +
      "call_integration_tool, its `integration`, a `description` and the `connections` it " +
      "reaches, each with the `connection_id` to pass; `catalog_unreadable: true` marks a typed " +
      "tool whose server could not be listed, named without description or schema. " +
      "`total` counts every match; `note` says when more matched than are shown, or when a " +
      "server lists more tools than are read. Present when not empty, filtered like the tools: " +
      "`not_ready`, the integrations active here you have no usable connection of, each with " +
      "its `proxy_connection` verdict (`status`, `imposed`) and, when a selection refusal " +
      "explains it, that `refusal`, whose `connect_url` is a single-use link to hand to the " +
      "user, which connects the integration as them; `unlisted`, the remote integrations whose " +
      "server the platform refused to list, with that `refusal`: their typed tools are missing " +
      "until it is cleared. With `credential-proxy:call-own` alone, a connection another " +
      "member shared is reached through " +
      (ctx.runs ? "a run (run_and_wait). " : "an agent run only. ") +
      "With `query` or `integration`, `best_match` adds to the top result (a tool's exact " +
      "name ranks first) its `input_schema` and its `usage`: how to call it, how to read its " +
      "result and what its connections' fields mean.",
    annotations: {
      title: "Search integration tools",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Free-text keywords matched against tool name, integration and description.",
        },
        integration: {
          type: "string",
          description: "Restrict to one integration, by package id (`@scope/name`).",
        },
        limit: {
          type: "integer",
          description: `Max results (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).`,
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const start = performance.now();
    const integration = typeof args.integration === "string" ? args.integration : undefined;
    const limit = searchLimit(args.limit);
    const tokens = searchTokens(args.query);
    const read = await readIntegrationTools(ctx, integration ? { integration } : {});
    if ("refused" in read)
      return listingRefused(ctx, "search_integration_tools", start, read.refused);

    const about = (id: string, text = "") =>
      tokens.length === 0 || searchScore(`${id} ${text}`, tokens) > 0;
    const notReadyShown = read.notReady
      .filter((entry) => about(entry.integration_package_id, entry.display_name))
      .map(({ integration_package_id, ...entry }) => ({
        integration: integration_package_id,
        ...entry,
      }));
    const unlistedShown = read.unlisted
      .filter((entry) => about(entry.integration_package_id))
      .map(({ integration_package_id, refusal }) => ({
        integration: integration_package_id,
        refusal,
      }));
    const matches = rankByKeywords(read.tools, tokens, (tool) => ({
      name: tool.name,
      text: `${tool.integration} ${tool.description}`,
    }));
    const shown = matches.slice(0, limit);
    ctx.observe({
      tool: "search_integration_tools",
      durationMs: performance.now() - start,
      shownCount: shown.length,
      outcome: "invoked",
    });
    const notes: string[] = [];
    if (matches.length > shown.length) {
      notes.push(
        `${matches.length - shown.length} more tool(s) match than the ${limit} shown: narrow ` +
          "with `query`, or pass `integration` to search one integration" +
          (limit < MAX_SEARCH_LIMIT ? `, or raise \`limit\` (at most ${MAX_SEARCH_LIMIT}).` : "."),
      );
    }
    const truncated = read.truncatedCatalogs.filter((entry) => about(entry.integration_package_id));
    for (const entry of truncated) {
      notes.push(
        `${entry.integration_package_id}'s server lists more tools than the ${entry.max_tools} read: ` +
          "a tool it lists after those is not offered.",
      );
    }
    if (
      integration !== undefined &&
      matches.length === 0 &&
      notReadyShown.length === 0 &&
      unlistedShown.length === 0
    ) {
      notes.push(
        tokens.length > 0
          ? `No tool of ${integration} matches \`query\`; search without it to list them all.`
          : `${integration} offers you no tool to call in this space.`,
      );
    }
    const top = shown[0];
    const searched = tokens.length > 0 || integration !== undefined;
    return jsonResult({
      total: matches.length,
      tools: shown.map(listedTool),
      ...(notReadyShown.length > 0 ? { not_ready: notReadyShown } : {}),
      ...(unlistedShown.length > 0 ? { unlisted: unlistedShown } : {}),
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
      ...(searched && top
        ? {
            best_match: {
              ...listedTool(top),
              usage: top.usage,
              input_schema: top.inputSchema,
            },
          }
        : {}),
    });
  };

  return { descriptor, handler };
}

const callSchema = z.strictObject({
  tool: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
  connection_id: z.uuid().optional(),
});

function buildCallIntegrationToolTool(ctx: IntegrationToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "call_integration_tool",
    description:
      "Call a tool search_integration_tools returned, by its `tool` name, with `arguments` " +
      "following its `input_schema`; its `usage` (in `best_match`, which a search by the " +
      "tool's exact name returns) says how to read the result. A missing required argument is " +
      "refused before anything is sent; an `api_call` tool refuses any other argument it does " +
      "not declare the same way, while a typed tool's server validates the rest itself. Call " +
      "directly for deterministic or bulk reads and writes" +
      (ctx.runs
        ? "; delegate to run_and_wait instead when the task needs judgement, several dependent " +
          "steps, an agent's configured tools, or, holding `credential-proxy:call-own` alone, a " +
          "connection another member shared."
        : "."),
    annotations: {
      title: "Call an integration tool",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["tool", "arguments"],
      properties: {
        tool: {
          type: "string",
          description: "The tool's name, as search_integration_tools returned it.",
        },
        arguments: {
          type: "object",
          description: "The tool's arguments, following its `input_schema`.",
        },
        connection_id: {
          type: "string",
          description:
            "The connection to call with, one of the tool's `connections[].connection_id`. " +
            "Without it the proxy chooses as for an `api_call`, and refuses with the candidate " +
            "connections when several qualify. For an `api_call` tool, it applies to each " +
            "request that names no `connection_id` of its own.",
        },
      },
    },
  };

  const handler = async (
    args: Record<string, unknown>,
    extra: AppstrateRequestExtra,
  ): Promise<CallToolResult> => {
    const start = performance.now();
    // A malformed call is refused whole, before any request is sent.
    const refuse = (refusal: Refusal): CallToolResult => {
      ctx.observe({
        tool: "call_integration_tool",
        durationMs: performance.now() - start,
        outcome: "rejected",
      });
      return refusalResult(refusal);
    };
    for (const name of ["tool", "arguments"] as const) {
      if (args[name] === undefined) {
        return refuse({
          code: "missing_argument",
          error: `${name} is required.`,
          arguments: [name],
        });
      }
    }
    const call = callSchema.safeParse(args);
    if (!call.success) return refuse(argumentsRefusal(call.error));

    const read = await readIntegrationTools(ctx, {
      name: call.data.tool,
      ...(call.data.connection_id ? { connectionId: call.data.connection_id } : {}),
    });
    if ("refused" in read) return listingRefused(ctx, "call_integration_tool", start, read.refused);
    const tool = read.tools.find((t) => t.name === call.data.tool);
    const unlisted = read.unlisted[0];
    if (!tool && unlisted) {
      // A remote server's listing was refused (connection, permission): the refusal says why.
      ctx.observe({
        tool: "call_integration_tool",
        durationMs: performance.now() - start,
        outcome: "invoked",
      });
      return jsonResult(unlisted.refusal as unknown as Record<string, unknown>, true);
    }
    if (!tool) {
      return refuse({
        code: "unknown_tool",
        error: `No integration tool named ${call.data.tool} is callable by you in this space.`,
        arguments: ["tool"],
        hint: "Take the name from search_integration_tools.",
      });
    }

    const required: unknown[] = Array.isArray(tool.inputSchema.required)
      ? tool.inputSchema.required
      : [];
    for (const name of required) {
      if (typeof name !== "string") continue;
      if (call.data.arguments[name] === undefined) {
        return refuse({
          code: "missing_argument",
          error: `arguments.${name} is required.`,
          arguments: [`arguments.${name}`],
        });
      }
    }
    const parsed = tool.schema.safeParse(call.data.arguments);
    if (!parsed.success) return refuse(argumentsRefusal(parsed.error, ["arguments"]));
    const outcome = await tool.execute(parsed.data, extra, call.data.connection_id);
    if ("code" in outcome) return refuse(outcome);
    ctx.observe({
      tool: "call_integration_tool",
      durationMs: performance.now() - start,
      shownCount: outcome.shownCount,
      outcome: "invoked",
    });
    return outcome.result;
  };

  return { descriptor, handler };
}

/** Declared together, to a caller `McpSurface.proxies` holds for. */
export function buildIntegrationTools(ctx: IntegrationToolContext): AppstrateToolDefinition[] {
  return [buildSearchIntegrationToolsTool(ctx), buildCallIntegrationToolTool(ctx)];
}
