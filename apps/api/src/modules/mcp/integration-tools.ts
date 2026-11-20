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
import { readSpaces, unsearched } from "./discovery.ts";
import {
  MAX_LISTED_SCOPES,
  readIntegrationTools,
  type CallableListing,
  type CallableTool,
  type ListingRefusal,
} from "./integration-tool-catalog.ts";
import { MAX_SEARCH_LIMIT, rankByKeywords, searchScore, type KeywordScore } from "./search.ts";
import { asRecord, jsonResult, refusalResult, type Refusal } from "./tool-results.ts";
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

/** The listing route's refusal, as `invoke_operation` would relay it. */
export function listingRefused(
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

/** A tool listed in one or more spaces of an org-wide call (`granted_in`); pinned, in the one. */
type SpaceTool = CallableTool & { granted_in?: string[] };

/** A tool as a search lists it, its connections among the section's `connections`. */
function listedTool(tool: SpaceTool): Record<string, unknown> {
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
function describedTool(tool: SpaceTool): Record<string, unknown> {
  return {
    kind: "integration_tool",
    ...listedTool(tool),
    usage: tool.usage,
    input_schema: tool.input_schema,
    ...(tool.kind === "remote" && tool.output_schema ? { output_schema: tool.output_schema } : {}),
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
  "`integration_tool` in `kinds`, or an `integration`, reads remote catalogs from their servers " +
  "(the connection's credential is sent, journaled as its call); otherwise remote catalogs are " +
  "read from the cache alone, a cold one's tools are listed by name only " +
  "(`catalog_unreadable: true`) and the integration is named in `uncached`.";

interface IntegrationToolSearch {
  /** The section `search` answers under `integration_tools`. */
  section: Record<string, unknown>;
  /** The best tool, for `best_match`, when keywords matched one whose catalog was read. */
  top?: { score: KeywordScore; described: Record<string, unknown> };
}

/** A listed entry with the space of an org-wide call it comes from (none when pinned). */
type InSpace<T> = T & { space_id?: string };

/** Whether a tool's descriptor is its server's own (its catalog was read), not a name alone. */
const isReadable = (tool: CallableTool) => !(tool.kind === "remote" && tool.catalog_unreadable);

/**
 * The listings of `reads`, one per space of an org-wide call (`spaceId` set) or the one of a
 * pinned connection, as one: a tool listed in several spaces once, under `granted_in`, with the
 * union of its connection ids and missing scopes and the readable descriptor if any space read
 * it; each connection once per space listing it; a `not_ready` or `unlisted` entry naming the
 * space it comes from. A space whose listing was refused is reported apart; all refused answers
 * the first.
 */
async function readAcrossSpaces(
  reads: readonly { spaceId: string | undefined; ctx: IntegrationToolContext }[],
  query: { integration?: string; cachedOnly: boolean },
  signal: AbortSignal | undefined,
): Promise<
  | {
      tools: SpaceTool[];
      connections: InSpace<CallableListing["connections"][number]>[];
      not_ready: InSpace<CallableListing["not_ready"][number]>[];
      unlisted: InSpace<CallableListing["unlisted"][number]>[];
      truncated_catalogs: CallableListing["truncated_catalogs"];
      uncached: string[];
      refusedSpaces: { spaceId: string | undefined; refused: ListingRefusal }[];
    }
  | { refused: ListingRefusal }
> {
  const { answered, refused } = await readSpaces(reads, ({ ctx }) =>
    readIntegrationTools(
      ctx,
      {
        ...(query.integration ? { integration: query.integration } : {}),
        ...(query.cachedOnly ? { cachedOnly: true } : {}),
      },
      signal,
    ),
  );
  if (answered.length === 0 && refused[0]) return { refused: refused[0].refused };

  const tools = new Map<string, SpaceTool>();
  const connections: InSpace<CallableListing["connections"][number]>[] = [];
  const truncated = new Map<string, CallableListing["truncated_catalogs"][number]>();
  const uncached = new Set<string>();
  const notReady: InSpace<CallableListing["not_ready"][number]>[] = [];
  const unlisted: InSpace<CallableListing["unlisted"][number]>[] = [];
  for (const {
    space: { spaceId },
    value: read,
  } of answered) {
    const from = spaceId ? { space_id: spaceId } : {};
    for (const tool of read.tools) {
      const key = `${tool.integration_package_id}\0${tool.name}`;
      const found = tools.get(key);
      const base = found && (isReadable(found) || !isReadable(tool)) ? found : tool;
      const merged: SpaceTool = {
        ...base,
        connection_ids: [...new Set([...(found?.connection_ids ?? []), ...tool.connection_ids])],
        ...(spaceId ? { granted_in: [...(found?.granted_in ?? []), spaceId] } : {}),
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
    for (const connection of read.connections) connections.push({ ...connection, ...from });
    for (const entry of read.truncated_catalogs) truncated.set(entry.integration_package_id, entry);
    for (const name of read.uncached) uncached.add(name);
    for (const entry of read.not_ready) notReady.push({ ...entry, ...from });
    for (const entry of read.unlisted) unlisted.push({ ...entry, ...from });
  }
  return {
    tools: [...tools.values()],
    connections,
    not_ready: notReady,
    unlisted,
    truncated_catalogs: [...truncated.values()],
    uncached: [...uncached],
    refusedSpaces: refused.map(({ space, refused: route }) => ({
      spaceId: space.spaceId,
      refused: route,
    })),
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
 * The integration tools a search lists, ranked by `tokens`, the remote catalogs read from the
 * cache alone when `cachedOnly`; one read per entry of `reads`, concurrently.
 */
export async function searchIntegrationTools(
  reads: readonly { spaceId: string | undefined; ctx: IntegrationToolContext }[],
  query: { tokens: readonly string[]; integration?: string; limit: number; cachedOnly: boolean },
  signal: AbortSignal | undefined,
): Promise<IntegrationToolSearch | { refused: ListingRefusal }> {
  const { tokens, integration, limit, cachedOnly } = query;
  const read = await readAcrossSpaces(reads, { integration, cachedOnly }, signal);
  if ("refused" in read) return { refused: read.refused };

  const about = (id: string, text = "") =>
    tokens.length === 0 || searchScore(`${id} ${text}`, tokens) > 0;
  const notReadyShown = read.not_ready.filter((entry) =>
    about(entry.integration_package_id, entry.display_name),
  );
  const unlistedShown = read.unlisted.filter((entry) => about(entry.integration_package_id));
  const fields = (tool: SpaceTool) => ({
    name: tool.name,
    text: `${tool.integration_package_id} ${tool.description}`,
  });
  const ranked = rankByKeywords(read.tools, tokens, fields);
  const matches = ranked.map(({ item }) => item);
  const shown = matches.slice(0, limit);
  const reached = new Set(shown.flatMap((tool) => tool.connection_ids));
  const notes: string[] = [];
  if (notReadyShown.length > 0) {
    notes.push(
      "`not_ready` lists the integrations active in a space searched that you have no usable connection of, each " +
        "with its `proxy_connection` verdict and, when a selection refusal explains it, that " +
        "`refusal`, whose `connect_url` is a single-use link to hand to the user.",
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
  for (const entry of read.truncated_catalogs.filter((e) => about(e.integration_package_id))) {
    notes.push(
      `${entry.integration_package_id}'s catalog is incomplete: only the first ${entry.listed_tools} ` +
        "tool(s) its server lists were read, and a tool listed after them is not offered. " +
        "Narrow with `integration`, or search the tool by name.",
    );
  }
  // Every one, whatever the query: a catalog not read may hold the very tool searched for.
  const { uncached } = read;
  if (uncached.length > 0) {
    notes.push(
      `The catalog of ${uncached.join(", ")} was not read (it is not cached), so its typed ` +
        'tools are listed by name alone: search with `kinds: ["integration_tool"]` to read it.',
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
  // A tool known by name alone (its catalog not read) has no schema: never the best match.
  const top = ranked.find(({ item }) => isReadable(item));
  return {
    section: {
      total: matches.length,
      items: shown.map(listedTool),
      ...(reached.size > 0
        ? {
            connections: read.connections
              .filter((c) => reached.has(c.connection_id))
              .map(listedConnection),
          }
        : {}),
      ...(notReadyShown.length > 0 ? { not_ready: notReadyShown } : {}),
      ...(unlistedShown.length > 0 ? { unlisted: unlistedShown } : {}),
      ...(uncached.length > 0 ? { uncached } : {}),
      ...unsearched(read.refusedSpaces),
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    },
    ...(tokens.length > 0 && top
      ? {
          top: {
            score: top.score,
            described: {
              ...describedTool(top.item),
              ...reachedBy(top.item, read.connections),
            },
          },
        }
      : {}),
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
  if ("refused" in read) return listingRefused(ctx, "describe", start, read.refused);
  ctx.observe({ tool: "describe", durationMs: performance.now() - start, outcome: "invoked" });
  const candidates = read.tools.filter((t) => t.name === name);
  const tool = candidates[0];
  const unlisted = read.unlisted[0];
  if (candidates.length === 1 && tool) {
    return jsonResult({ ...describedTool(tool), ...reachedBy(tool, read.connections) });
  }
  if (!tool && unlisted)
    return jsonResult(unlisted.refusal as unknown as Record<string, unknown>, true);
  return refusalResult({
    code: candidates.length > 1 ? "ambiguous_tool" : "unknown_tool",
    error:
      candidates.length > 1
        ? `${name} names ${candidates.length} tools; none is described.`
        : `No integration tool named ${name} is callable by you in this space.`,
    arguments: ["id"],
    ...(candidates.length > 1 ? {} : { hint: "Take the id from search." }),
  });
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
      "following its `input_schema`; its `usage` (from describe, or search's `best_match`) " +
      "says how to read the result. A missing required argument is " +
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
    if ("refused" in read) return listingRefused(ctx, "call_integration_tool", start, read.refused);
    const candidates = read.tools.filter((t) => t.name === call.data.tool);
    if (candidates.length > 1) {
      // Names are unique in a space: two tools under one name are never called by a guess.
      return refuse({
        code: "ambiguous_tool",
        error: `${call.data.tool} names ${candidates.length} tools of ${[
          ...new Set(candidates.map((t) => t.integration_package_id)),
        ].join(", ")}; none is called.`,
        arguments: ["tool"],
      });
    }
    const tool = candidates[0];
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
        hint: "Take the id from search.",
      });
    }

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
