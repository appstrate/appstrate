// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * One reading of a `tools/list` page, for every HTTP client of this package, applying the one
 * rule MCP 2026-07-28 puts on Streamable HTTP clients (SEP-2243): a tool whose `inputSchema`
 * carries an invalid `x-mcp-header` declaration MUST be excluded from the list. The server sync
 * and the sidecar read pages through the same function, so the sync never proposes a tool the
 * sidecar would then drop. The page's shape is the SDK's to validate first; this reading stays
 * defensive (an entry without a name or schema is dropped) rather than trusting it.
 *
 * The header rule mirrors the v2 SDK's `scanXMcpHeaderDeclarations`, which its public entry
 * points do not export. It is applied here rather than left to the SDK's `listTools()` because
 * that walks every page itself, answers an empty list without asking a server that advertises no
 * `tools` capability, and writes to the console.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** A page as read: the well-formed tools, the cursor, and each tool excluded with its reason. */
export interface ToolListPage {
  tools: Tool[];
  nextCursor?: string;
  excluded: { name: string; reason: string }[];
}

/**
 * Read a raw `tools/list` result. `applyHeaderRule` is true on a 2026-07-28 connection, where
 * the rule binds; a legacy connection carries no per-request headers.
 */
export function readToolListPage(raw: unknown, applyHeaderRule: boolean): ToolListPage {
  const result = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const entries = Array.isArray(result.tools) ? result.tools : [];
  const page: ToolListPage = { tools: [], excluded: [] };
  for (const entry of entries) {
    if (!isToolShaped(entry)) continue;
    const fault = applyHeaderRule ? xMcpHeaderFault(entry.inputSchema) : undefined;
    if (fault === undefined) page.tools.push(entry);
    else page.excluded.push({ name: entry.name, reason: fault });
  }
  if (typeof result.nextCursor === "string" && result.nextCursor !== "") {
    page.nextCursor = result.nextCursor;
  }
  return page;
}

function isToolShaped(entry: unknown): entry is Tool {
  if (typeof entry !== "object" || entry === null) return false;
  const { name, inputSchema } = entry as { name?: unknown; inputSchema?: unknown };
  return (
    typeof name === "string" &&
    name !== "" &&
    typeof inputSchema === "object" &&
    inputSchema !== null
  );
}

const X_MCP_HEADER_KEY = "x-mcp-header";
/** RFC 9110 §5.1 `token` (`1*tchar`). */
const RFC9110_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/**
 * The spec names `string`, `integer`, `boolean`; the SDK also admits `number` (the conformance
 * referee mirrors it), and the client is the SDK, so the list follows it.
 */
const PRIMITIVE_TYPES = new Set(["string", "integer", "boolean", "number"]);
/** Subschema positions the `properties`-only chain must not pass through. */
const NON_REACHABLE_KEYWORDS = [
  "items",
  "prefixItems",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "patternProperties",
  "dependentSchemas",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "$defs",
  "definitions",
];
const OBJECT_VALUED_KEYWORDS = new Set([
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
]);

/** The first violated `x-mcp-header` constraint of a schema, or `undefined` when it has none. */
function xMcpHeaderFault(inputSchema: unknown): string | undefined {
  const seen = new Map<string, string>();
  const visit = (node: unknown, path: string[], reachable: boolean): string | undefined => {
    if (node === null || typeof node !== "object") return undefined;
    const schema = node as Record<string, unknown>;
    const at = path.length === 0 ? "<root>" : path.join(".");
    if (X_MCP_HEADER_KEY in schema) {
      if (!reachable || path.length === 0) {
        return `${at}: x-mcp-header is only permitted on properties reachable through 'properties' alone`;
      }
      const raw = schema[X_MCP_HEADER_KEY];
      if (typeof raw !== "string" || raw === "")
        return `${at}: x-mcp-header must be a non-empty string`;
      if (!RFC9110_TOKEN.test(raw)) return `${at}: x-mcp-header '${raw}' is not an RFC 9110 token`;
      const type = typeof schema.type === "string" ? schema.type : undefined;
      if (type === undefined || !PRIMITIVE_TYPES.has(type)) {
        return `${at}: x-mcp-header is only permitted on primitive-typed properties`;
      }
      const prior = seen.get(raw.toLowerCase());
      if (prior !== undefined) return `x-mcp-header '${raw}' is not unique (also '${prior}')`;
      seen.set(raw.toLowerCase(), raw);
    }
    const properties = schema.properties;
    if (properties !== null && typeof properties === "object") {
      for (const [key, child] of Object.entries(properties)) {
        const fault = visit(child, [...path, key], reachable);
        if (fault !== undefined) return fault;
      }
    }
    for (const keyword of NON_REACHABLE_KEYWORDS) {
      const sub = schema[keyword];
      if (sub === undefined) continue;
      const branches = Array.isArray(sub)
        ? sub
        : sub !== null && typeof sub === "object" && OBJECT_VALUED_KEYWORDS.has(keyword)
          ? Object.values(sub)
          : [sub];
      for (const branch of branches) {
        const fault = visit(branch, [...path, `<${keyword}>`], false);
        if (fault !== undefined) return fault;
      }
    }
    return undefined;
  };
  return visit(inputSchema, [], true);
}
