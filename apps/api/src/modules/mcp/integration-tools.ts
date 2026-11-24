// SPDX-License-Identifier: Apache-2.0

/**
 * The tools of the integrations the caller holds a connection of, outside a run: `search` lists
 * them (its `integration_tool` kind), `describe` details one, and `call_integration_tool` calls
 * one.
 *
 * All three read the tools from the proxy's listing route (`integration-tool-catalog.ts`), which
 * names each one (`{ns}__api_call`, `{ns}__api_call__{auth}`, `{ns}__{tool}`), describes it and
 * lists its connections; here a search only filters and ranks them, and a call resolves its tool
 * by its full name and runs it. Every upstream request is dispatched in-process to
 * the proxy routes (`routes/credential-proxy.ts`), so the guard, the rate limit and the access
 * rule (`services/credential-proxy/access.ts`) are the REST door's and none is restated here.
 * Those routes are kept out of the operation catalog (`isExcludedPath`): `call_integration_tool`
 * and the `integration_tool` kind of `search` and `describe` are the one MCP path to them, with
 * typed arguments where `/proxy` takes control headers and a bounded result where it relays the
 * upstream body.
 *
 * Calling stays a tool of its own, not an operation of `invoke_operation`: it relays the upstream
 * `CallToolResult` as is (content blocks, `isError`), which an operation's `{ status, body }`
 * cannot carry.
 */

import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateRequestExtra, AppstrateToolDefinition } from "@appstrate/mcp-transport";
import { renderFieldPath } from "@appstrate/core/api-errors";
import type { DispatchContext } from "./api-call-batch.ts";
import { INTEGRATION_TOOLS_PATH } from "./catalog.ts";
import { readSpaces, spacesShown, unsearched } from "./discovery.ts";
import {
  MAX_LISTED_SCOPES,
  readIntegrationTools,
  type CallableListing,
  type CallableTool,
} from "./integration-tool-catalog.ts";
import { MAX_SEARCH_LIMIT, rankByKeywords, searchScore } from "./search.ts";
import {
  asRecord,
  jsonResult,
  refusalResult,
  type Refusal,
  type RouteRefusal,
} from "./tool-results.ts";
import type { McpSpace } from "./spaces.ts";
import type { McpObserver, McpToolName } from "./tools.ts";

export interface IntegrationToolContext extends DispatchContext {
  observe: McpObserver;
  /** The caller is also offered `run_and_wait`, so the descriptions may name it. */
  runs: boolean;
}

/** Issues one argument refusal names. */
const MAX_REPORTED_ISSUES = 10;

/** The value at `path` in `value`, `undefined` when a step is missing. */
function valueAt(value: unknown, path: readonly PropertyKey[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

/** The refusal of arguments the tool does not declare. */
function unknownArgumentsRefusal(unknown: string[]): Refusal {
  return {
    code: "unknown_argument",
    error: `Unknown argument(s): ${unknown.join(", ")}.`,
    arguments: unknown,
  };
}

/**
 * The refusal of a parse of `input`; `prefix` places the parsed object among the tool's
 * arguments. Required arguments absent and nothing else is `missing_argument`; any other issue is
 * `invalid_argument`, naming the absent ones beside it.
 */
function argumentsRefusal(error: z.ZodError, input: unknown, prefix: PropertyKey[] = []): Refusal {
  const path = (issuePath: PropertyKey[]) => renderFieldPath([...prefix, ...issuePath]);
  const unknown = error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys" ? issue.keys.map((key) => path([...issue.path, key])) : [],
  );
  if (unknown.length > 0) return unknownArgumentsRefusal(unknown);
  const absent = (issue: (typeof error.issues)[number]) =>
    issue.code === "invalid_type" && valueAt(input, issue.path) === undefined;
  const issues = error.issues.slice(0, MAX_REPORTED_ISSUES);
  const missing = issues.filter(absent).map((issue) => path(issue.path));
  if (missing.length === issues.length) {
    return {
      code: "missing_argument",
      error: missing.map((name) => `${name} is required.`).join(" "),
      arguments: missing,
    };
  }
  return {
    code: "invalid_argument",
    error: issues
      .map((issue) =>
        absent(issue) ? `${path(issue.path)}: required` : `${path(issue.path)}: ${issue.message}`,
      )
      .join("; "),
    arguments: [...new Set(issues.map((issue) => path(issue.path)))],
  };
}

/** The listing route's refusal, observed as `invoke_operation` observes a route's. */
export function observeListingRefusal(
  ctx: IntegrationToolContext,
  tool: McpToolName,
  start: number,
  refused: RouteRefusal,
): RouteRefusal {
  ctx.observe({
    tool,
    durationMs: performance.now() - start,
    method: "GET",
    path: INTEGRATION_TOOLS_PATH,
    status: refused.status,
    outcome: "invoked",
  });
  return refused;
}

/** A connection as a search lists it: a long `scopes_granted` cut, its total beside it. */
function listedConnection<C extends { scopes_granted: string[] }>(connection: C) {
  const { scopes_granted: scopes } = connection;
  return scopes.length > MAX_LISTED_SCOPES
    ? {
        ...connection,
        scopes_granted: scopes.slice(0, MAX_LISTED_SCOPES),
        scopes_granted_count: scopes.length,
      }
    : connection;
}

/** A tool as a search lists it, its connections among the section's `connections`. */
function listedTool(tool: Merged<CallableTool>): Record<string, unknown> {
  return {
    id: tool.name,
    integration_package_id: tool.integration_package_id,
    description: tool.description,
    ...(tool.granted_in ? { granted_in: tool.granted_in } : {}),
    ...(tool.kind === "remote" && tool.catalog_unreadable ? { catalog_unreadable: true } : {}),
    connection_ids: tool.connection_ids,
    ...(tool.kind === "remote" && tool.missing_scopes
      ? { missing_scopes: tool.missing_scopes }
      : {}),
  };
}

/** A tool as `describe` details it: how to call it and read its result, and its schemas. */
function describedTool(tool: Merged<CallableTool>): Record<string, unknown> {
  return {
    kind: "integration_tool",
    ...listedTool(tool),
    usage: tool.usage,
    input_schema: tool.input_schema,
    ...(tool.kind === "remote" && tool.output_schema ? { output_schema: tool.output_schema } : {}),
    ...(tool.kind === "remote" && tool.schema_reduced
      ? { schema_reduced: tool.schema_reduced }
      : {}),
  };
}

/**
 * What `search` and `describe` do when they declare the kind: they may query third-party servers
 * with a connection's credential, which journals a call and can rotate its OAuth tokens.
 */
export const INTEGRATION_KIND_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** What `search` says of the integration tools, for its description: what is listed and how to call one. */
export const INTEGRATION_TOOLS_DESCRIPTION =
  " Integration tools are the tools of the integrations you hold a connection of, or that need " +
  "none, in the space: each integration's `api_call` tools and the typed tools of a remote MCP " +
  "server; call one with call_integration_tool, passing its `id` as `tool`. Naming " +
  "`integration_tool` in `kinds` reads remote catalogs from their servers (the connection's " +
  "credential is sent, journaled as its call); otherwise, an `integration` included, remote " +
  "catalogs are read from the cache alone, a cold one's tools are listed by name only " +
  "(`catalog_unreadable: true`); such an integration is named in `uncached` when it relates to the " +
  "query, otherwise counted in `note`.";

/** A listed entry, and the spaces of an org-wide call it is listed in (none when pinned). */
type Merged<T> = T & { granted_in?: string[] };

/** Whether a tool's descriptor is its server's own (its catalog was read), not a name alone. */
const isReadable = (tool: CallableTool) => !(tool.kind === "remote" && tool.catalog_unreadable);

/**
 * The listings of the spaces of an org-wide call, or the one of a pinned connection, as one: a
 * tool listed in several spaces once, under `granted_in`, with the union of its connection ids
 * and missing scopes and the readable descriptor if any space read it; a connection, `not_ready`
 * or `unlisted` entry the same in several spaces once, under `granted_in`; an uncached integration
 * once, under the spaces that report it. Each truncated catalog keeps its space and count.
 * A space whose listing was refused is reported apart; all refused answers the first.
 */
async function readAcrossSpaces(
  spaces: readonly McpSpace[] | undefined,
  contextIn: (space: McpSpace | undefined) => IntegrationToolContext,
  query: { integration?: string; cachedOnly: boolean },
  signal: AbortSignal | undefined,
) {
  const { answered, refused } = await readSpaces(spaces, (space) =>
    readIntegrationTools(
      contextIn(space),
      {
        ...(query.integration ? { integration: query.integration } : {}),
        ...(query.cachedOnly ? { cachedOnly: true } : {}),
      },
      signal,
    ),
  );
  if (answered.length === 0 && refused[0]) return { refused: refused[0].refused };

  const tools = new Map<string, Merged<CallableTool>>();
  const truncatedCatalogs: Merged<CallableListing["truncated_catalogs"][number]>[] = [];
  const entries = {
    connections: new Map<string, Merged<CallableListing["connections"][number]>>(),
    not_ready: new Map<string, Merged<CallableListing["not_ready"][number]>>(),
    unlisted: new Map<string, Merged<CallableListing["unlisted"][number]>>(),
    uncached: new Map<string, Merged<{ integration_package_id: string }>>(),
  };
  const add = <T extends object>(into: Map<string, Merged<T>>, entry: T, space?: McpSpace) => {
    const key = JSON.stringify(entry);
    const found = into.get(key);
    if (found?.granted_in && space) found.granted_in.push(space.id);
    else into.set(key, space ? { ...entry, granted_in: [space.id] } : entry);
  };
  for (const { space, value: read } of answered) {
    for (const tool of read.tools) {
      const key = `${tool.integration_package_id}\0${tool.name}`;
      const found = tools.get(key);
      const base = found && (isReadable(found) || !isReadable(tool)) ? found : tool;
      const merged: Merged<CallableTool> = {
        ...base,
        connection_ids: [...new Set([...(found?.connection_ids ?? []), ...tool.connection_ids])],
        ...(space ? { granted_in: [...(found?.granted_in ?? []), space.id] } : {}),
      };
      if (merged.kind === "remote") {
        const scopes = {
          ...(found?.kind === "remote" ? found.missing_scopes : {}),
          ...(tool.kind === "remote" ? tool.missing_scopes : {}),
        };
        if (Object.keys(scopes).length > 0) merged.missing_scopes = scopes;
      }
      tools.set(key, merged);
    }
    for (const connection of read.connections) add(entries.connections, connection, space);
    for (const entry of read.not_ready) add(entries.not_ready, entry, space);
    for (const entry of read.unlisted) add(entries.unlisted, entry, space);
    for (const entry of read.truncated_catalogs) {
      truncatedCatalogs.push(space ? { ...entry, granted_in: [space.id] } : entry);
    }
    for (const name of read.uncached)
      add(entries.uncached, { integration_package_id: name }, space);
  }
  return {
    tools: [...tools.values()],
    connections: [...entries.connections.values()],
    not_ready: [...entries.not_ready.values()],
    unlisted: [...entries.unlisted.values()],
    truncated_catalogs: truncatedCatalogs,
    uncached: [...entries.uncached.values()],
    refusedSpaces: refused,
  };
}

/** The `connections` a tool reaches among `listed`, as a search lists them. */
function reachedBy<C extends { connection_id: string; scopes_granted: string[] }>(
  tool: CallableTool,
  listed: readonly C[],
): { connections?: unknown[] } {
  const reached = new Set(tool.connection_ids);
  return reached.size > 0
    ? { connections: listed.filter((c) => reached.has(c.connection_id)).map(listedConnection) }
    : {};
}

/**
 * The integration tools section of a search, ranked by `tokens`, the remote catalogs read from the
 * cache alone when `cachedOnly`; one read per space (one for a pinned connection), concurrently.
 */
export async function searchIntegrationTools(
  spaces: readonly McpSpace[] | undefined,
  contextIn: (space: McpSpace | undefined) => IntegrationToolContext,
  query: { tokens: readonly string[]; integration?: string; limit: number; cachedOnly: boolean },
  signal: AbortSignal | undefined,
): Promise<{ section: Record<string, unknown>; searched: string[] } | { refused: RouteRefusal }> {
  const { tokens, integration, limit, cachedOnly } = query;
  const read = await readAcrossSpaces(spaces, contextIn, { integration, cachedOnly }, signal);
  if (read.refused) return { refused: read.refused };

  const about = (id: string, text = "") =>
    tokens.length === 0 || searchScore(`${id} ${text}`, tokens) > 0;
  const notReadyShown = read.not_ready.filter((entry) =>
    about(entry.integration_package_id, entry.display_name),
  );
  const unlistedShown = read.unlisted.filter((entry) => about(entry.integration_package_id));
  const truncatedShown = read.truncated_catalogs.filter((e) => about(e.integration_package_id));
  const matches = rankByKeywords(read.tools, tokens, (tool) => ({
    name: tool.name,
    text: `${tool.integration_package_id} ${tool.description}`,
  })).map(({ item }) => item);
  const shown = matches.slice(0, limit);
  const reached = new Set(shown.flatMap((tool) => tool.connection_ids));
  // An uncached integration relates to the search by its id or by a tool of it shown.
  const uncachedShown = read.uncached.filter(
    (e) =>
      about(e.integration_package_id) ||
      shown.some((tool) => tool.integration_package_id === e.integration_package_id),
  );
  const connectionsShown = read.connections.filter((c) => reached.has(c.connection_id));
  const notes: string[] = [];
  if (notReadyShown.length > 0) {
    notes.push(
      "`not_ready` lists the integrations active in a space searched that you have no usable connection of, each " +
        "with its `proxy_connection` verdict and, when a selection refusal explains it, that " +
        "`refusal`. For a requested direct call, follow the space-choice instructions for that refusal " +
        "even when it includes a `connect_url` for connecting here.",
    );
  }
  if (unlistedShown.length > 0) {
    notes.push(
      "`unlisted` lists the remote integrations whose server the platform refused to list, " +
        "with that `refusal`.",
    );
  }
  if (matches.length > shown.length) {
    notes.push(
      `${matches.length - shown.length} more tool(s) match than the ${limit} shown: narrow ` +
        "with `query`, or pass `integration` to search one integration" +
        (limit < MAX_SEARCH_LIMIT ? `, or raise \`limit\` (at most ${MAX_SEARCH_LIMIT}).` : "."),
    );
  }
  if (read.uncached.length > uncachedShown.length) {
    notes.push(
      `${read.uncached.length - uncachedShown.length} other integration(s) have no cached catalog, so ` +
        "their tools may not match by description: search again with " +
        '`kinds: ["integration_tool"]` to read them.',
    );
  }
  for (const [id, catalogs] of Map.groupBy(
    truncatedShown,
    (entry) => entry.integration_package_id,
  )) {
    const count = catalogs[0]!.listed_tools;
    const detail = catalogs.every((entry) => entry.listed_tools === count)
      ? `only the first ${count} tool(s) were read from each truncated catalog`
      : "the number of tools read varies by space";
    notes.push(
      `${id}'s catalog is incomplete: ${detail}. Narrow with \`integration\`, or search the tool by name.`,
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
        : `${integration} offers you no tool to call in the spaces searched.`,
    );
  }
  return {
    section: {
      total: matches.length,
      items: shown.map(listedTool),
      ...(reached.size > 0 ? { connections: connectionsShown.map(listedConnection) } : {}),
      ...(notReadyShown.length > 0 ? { not_ready: notReadyShown } : {}),
      ...(unlistedShown.length > 0 ? { unlisted: unlistedShown } : {}),
      ...(uncachedShown.length > 0
        ? { uncached: uncachedShown.map((e) => e.integration_package_id) }
        : {}),
      ...unsearched(read.refusedSpaces),
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    },
    searched: spacesShown(
      shown,
      connectionsShown,
      notReadyShown,
      unlistedShown,
      truncatedShown,
      uncachedShown,
    ),
  };
}

/**
 * The tool named `name` among a listing read for it, or why none is: the refusal of a name that
 * lists none or several, or the problem of the remote server whose listing was refused.
 * `argument` is the argument that carried the name.
 */
function resolveToolByName(
  read: CallableListing,
  name: string,
  argument: string,
): { tool: CallableTool } | { refusal: Refusal } | { unlisted: Record<string, unknown> } {
  const candidates = read.tools.filter((t) => t.name === name);
  const [tool] = candidates;
  if (candidates.length === 1 && tool) return { tool };
  const unlisted = read.unlisted[0];
  if (!tool && unlisted)
    return { unlisted: unlisted.refusal as unknown as Record<string, unknown> };
  if (tool) {
    // Names are unique in a space: two tools under one name are never chosen by a guess.
    return {
      refusal: {
        code: "ambiguous_tool",
        error: `${name} names ${candidates.length} tools of ${[
          ...new Set(candidates.map((t) => t.integration_package_id)),
        ].join(", ")}; none is chosen.`,
        arguments: [argument],
      },
    };
  }
  return {
    refusal: {
      code: "unknown_tool",
      error: `No integration tool named ${name} is callable by you in this space.`,
      arguments: [argument],
      hint: "Take the id from search.",
    },
  };
}

/**
 * One integration tool, resolved by its name as `call_integration_tool` resolves it: its schemas
 * and `usage`, or why it cannot be called.
 */
export async function describeIntegrationTool(
  ctx: IntegrationToolContext,
  name: string,
  signal: AbortSignal | undefined,
): Promise<CallToolResult> {
  const start = performance.now();
  const read = await readIntegrationTools(ctx, { name }, signal);
  if ("refused" in read) {
    return refusalResult(observeListingRefusal(ctx, "describe", start, read.refused));
  }
  ctx.observe({ tool: "describe", durationMs: performance.now() - start, outcome: "invoked" });
  const found = resolveToolByName(read, name, "id");
  if ("tool" in found) {
    return jsonResult({ ...describedTool(found.tool), ...reachedBy(found.tool, read.connections) });
  }
  return "unlisted" in found ? jsonResult(found.unlisted, true) : refusalResult(found.refusal);
}

const callSchema = z.strictObject({
  tool: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
  connection_id: z.uuid().optional(),
});

export function buildCallIntegrationToolTool(ctx: IntegrationToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "call_integration_tool",
    description:
      "Call an integration tool search returned, by its `id` passed as `tool`, with `arguments` " +
      "following its `input_schema`; its `usage` (from describe) " +
      "says how to read the result. Before calling several tools, read their schemas with ONE " +
      "describe passing their ids in `ids`, not one describe per tool. A missing required argument is " +
      "refused before anything is sent; an `api_call` tool refuses any other argument it does " +
      "not declare the same way, and so does a typed tool whose `input_schema` closes its " +
      "properties (`additionalProperties: false`); a typed tool's server validates the rest " +
      "itself, and may answer with a protocol error or with its own `isError` tool result. " +
      "`tool_catalog_unavailable` means the catalog of a typed tool's server could not be read " +
      "to say which of its tools the name is (`listing_failure`, when known, says why): " +
      "nothing was sent, and a retry may succeed once a listing reads it. Call " +
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
          description: "The tool's `id`, as search returned it.",
        },
        arguments: {
          type: "object",
          description: "The tool's arguments, following its `input_schema`.",
        },
        connection_id: {
          type: "string",
          description:
            "The connection to call with, one of the tool's `connection_ids`. " +
            "Without it the proxy chooses as for an `api_call`, and refuses with the candidate " +
            "connections when several qualify. For an `api_call` tool, it applies to each " +
            "request that names no `connection_id` of its own. Omit it for a tool whose " +
            "`connection_ids` is empty: its integration binds no connection.",
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
    const call = callSchema.safeParse(args);
    if (!call.success) return refuse(argumentsRefusal(call.error, args));

    const read = await readIntegrationTools(
      ctx,
      {
        name: call.data.tool,
        ...(call.data.connection_id ? { connectionId: call.data.connection_id } : {}),
      },
      extra.signal,
    );
    if ("refused" in read) {
      return refusalResult(
        observeListingRefusal(ctx, "call_integration_tool", start, read.refused),
      );
    }
    const found = resolveToolByName(read, call.data.tool, "tool");
    if ("unlisted" in found) {
      // A remote server's listing was refused (connection, permission): the refusal says why.
      ctx.observe({
        tool: "call_integration_tool",
        durationMs: performance.now() - start,
        outcome: "invoked",
      });
      return jsonResult(found.unlisted, true);
    }
    if ("refusal" in found) return refuse(found.refusal);
    const { tool } = found;

    let toolArguments: unknown = call.data.arguments;
    if (tool.schema) {
      const parsed = tool.schema.safeParse(call.data.arguments);
      if (!parsed.success) {
        return refuse(argumentsRefusal(parsed.error, call.data.arguments, ["arguments"]));
      }
      toolArguments = parsed.data;
    } else {
      // A typed tool: required arguments present and, when its schema closes its properties, no
      // unknown key (a missing `properties` allows none); its server validates the rest. Only the
      // plain form is judged: `patternProperties` would mean running the server's regexes, and
      // under composition (allOf, anyOf, oneOf, $ref) validators disagree with JSON Schema's
      // sibling-only rule, so the platform never refuses what the server might accept.
      const schema = tool.input_schema;
      const composed = ["patternProperties", "allOf", "anyOf", "oneOf", "$ref"].some(
        (keyword) => keyword in schema,
      );
      if (schema.additionalProperties === false && !composed) {
        const properties = asRecord(schema.properties) ?? {};
        const unknown = Object.keys(call.data.arguments).filter(
          (key) => !Object.hasOwn(properties, key),
        );
        if (unknown.length > 0) {
          return refuse(unknownArgumentsRefusal(unknown.map((key) => `arguments.${key}`)));
        }
      }
      const required = Array.isArray(tool.input_schema.required) ? tool.input_schema.required : [];
      const missing = required.filter(
        (name): name is string =>
          typeof name === "string" && call.data.arguments[name] === undefined,
      );
      if (missing.length > 0) {
        return refuse({
          code: "missing_argument",
          error: missing.map((name) => `arguments.${name} is required.`).join(" "),
          arguments: missing.map((name) => `arguments.${name}`),
        });
      }
    }
    const outcome = await tool.execute(toolArguments, extra, call.data.connection_id);
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
