// SPDX-License-Identifier: Apache-2.0

/**
 * Tool descriptor sanitisation.
 *
 * The 2026 MCP ecosystem has accumulated multiple "tool poisoning"
 * attack patterns where third-party MCP servers smuggle prompt-
 * injection payloads into tool descriptions, parameter descriptions,
 * or schema annotations:
 *
 *   - Hidden Unicode (zero-width space U+200B, RTL marks U+202E, …).
 *   - "IGNORE PREVIOUS INSTRUCTIONS" payloads inside long descriptions.
 *   - Schema-level injection via `description` fields on nested
 *     `properties` (Full-Schema Poisoning per CyberArk/Invariant Labs).
 *   - Privileged capability-marker forgery via tool `_meta`.
 *
 * This module is the single defence applied to every third-party tool
 * before it reaches the agent's LLM. It is deliberately conservative:
 * we strip control characters, cap field lengths, and never trust
 * upstream content beyond the limits documented here.
 *
 * Limits:
 *   - Tool description ≤ 2048 bytes.
 *   - Parameter description ≤ 512 bytes.
 *   - Input + output schema serialised size ≤ 8192 bytes, shared.
 *
 * A descriptor over the schema budget is degraded, never dropped: its
 * `outputSchema` goes first, then the input schema's documentation keywords,
 * then the input schema itself, which leaves `{ type: "object" }` and a note in
 * the description; the `outputSchema` stays when it fits beside the reduced
 * input ({@link sanitiseToolDescriptor}). Every step taken is reported to the
 * caller.
 *
 * What this module deliberately does NOT do:
 *   - Block specific phrases ("IGNORE PREVIOUS"). The LLM's own
 *     instruction-tuning is the right line of defence for content; we
 *     just keep the sanitised payload below sizes that overwhelm it.
 *   - Round-trip the schema through a strict JSON Schema validator —
 *     that's a registry-boundary concern, enforced at publish time.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  API_CALL_TOOL_META_KEY,
  API_UPLOAD_TOOL_META_KEY,
  TOOL_INTEGRATION_META_KEY,
} from "./tool-meta.ts";

export const MAX_TOOL_DESCRIPTION_BYTES = 2048;
export const MAX_PARAMETER_DESCRIPTION_BYTES = 512;
export const MAX_SCHEMA_SERIALISED_BYTES = 8192;

/**
 * Hidden-Unicode code points frequently used to smuggle prompt-injection
 * payloads. We strip every entry in this set before any length
 * accounting so attackers can't pack bytes into otherwise-empty space.
 *
 * Coverage:
 *   - U+00AD soft hyphen
 *   - U+115F-U+1160 Hangul fillers
 *   - U+17B4-U+17B5 Khmer inherent vowels
 *   - U+180E Mongolian vowel separator
 *   - U+200B-U+200F zero-width chars + LRM/RLM
 *   - U+202A-U+202E bidi overrides
 *   - U+2060-U+206F word joiner / function annotators
 *   - U+3164 Hangul filler
 *   - U+FEFF BOM
 *   - U+FFA0 halfwidth Hangul filler
 *   - U+E0000-U+E007F tag characters (invisible, yet read by models)
 */
// Hidden code points stripped on every text field. Encoded as a
// per-code-point predicate (not a regex character class) because some
// adjacent fillers — e.g. Hangul ᅟ + ᅠ — render as a single
// combined glyph and trip eslint's no-misleading-character-class rule.
// The DB CHECK `integration_connections_label_normalized` mirrors this set (pinned by
// `apps/api/test/unit/lib/connection-label-check.test.ts`).
export function isHiddenCodePoint(cp: number): boolean {
  return (
    cp === 0x00ad ||
    cp === 0x115f ||
    cp === 0x1160 ||
    cp === 0x17b4 ||
    cp === 0x17b5 ||
    cp === 0x180e ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0x3164 ||
    cp === 0xfeff ||
    cp === 0xffa0 ||
    (cp >= 0xe0000 && cp <= 0xe007f)
  );
}

/** By code point: a tag character is a surrogate pair. */
function stripHiddenCodePoints(value: string): string {
  let out = "";
  for (const ch of value) {
    if (!isHiddenCodePoint(ch.codePointAt(0)!)) out += ch;
  }
  return out;
}

/**
 * C0 control characters (U+0000-U+001F) plus DEL (U+007F), with `\n`
 * and `\t` preserved.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "g");

/**
 * Truncate UTF-8 text to a hard byte cap, appending an explicit
 * `[truncated]` marker so the agent can detect bounded reads.
 */
function truncateText(value: string, maxBytes: number): string {
  const buf = new TextEncoder().encode(value);
  if (buf.byteLength <= maxBytes) return value;
  const sliced = buf.subarray(0, Math.max(0, maxBytes - "[truncated]".length));
  return `${new TextDecoder("utf-8", { fatal: false }).decode(sliced)}[truncated]`;
}

/** Strip hidden Unicode + control chars + truncate. */
export function sanitiseTextField(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = stripHiddenCodePoints(value).replace(CONTROL_CHARS_RE, "");
  return truncateText(clean, maxBytes);
}

/**
 * Max nesting depth walked when sanitising a schema. A hostile server could
 * otherwise send a pathologically deep object (`{a:{a:{a:…}}}`) to overflow
 * the stack before any size accounting runs. Legitimate JSON Schemas are
 * shallow; anything past this cap is treated as opaque and left un-recursed —
 * the serialised-size budget in {@link sanitiseToolDescriptor} still bounds the
 * total bytes that reach the agent, so an un-walked deep subtree cannot smuggle
 * an oversized payload through.
 */
const MAX_SCHEMA_DEPTH = 64;

/**
 * Recursively sanitise every `description` field inside a JSON Schema
 * `properties` block. Used to defeat Full-Schema Poisoning where the
 * payload hides inside nested `properties.x.description`. Bounded by
 * {@link MAX_SCHEMA_DEPTH} so a maliciously deep schema cannot exhaust the
 * call stack.
 */
function sanitiseSchemaDescriptions(schema: unknown, depth = 0): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (depth >= MAX_SCHEMA_DEPTH) return schema;
  if (Array.isArray(schema)) return schema.map((s) => sanitiseSchemaDescriptions(s, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "description" && typeof value === "string") {
      out[key] = sanitiseTextField(value, MAX_PARAMETER_DESCRIPTION_BYTES);
    } else if (typeof value === "object" && value !== null) {
      out[key] = sanitiseSchemaDescriptions(value, depth + 1);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Strip first-party capability markers from an untrusted tool descriptor while
 * preserving every unrelated metadata entry. The runtime treats these markers
 * as privileged routing claims: allowing a third-party MCP server to forge one
 * could make it impersonate the sidecar's credential proxy or upload sibling,
 * or report its calls as another integration's.
 *
 * `McpHost` deliberately bypasses {@link sanitiseToolDescriptor} for trusted
 * first-party tools, so genuine sidecar markers never pass through this filter.
 */
function sanitiseToolMeta(meta: Tool["_meta"]): Tool["_meta"] | undefined {
  if (!meta) return undefined;
  const out: NonNullable<Tool["_meta"]> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (
      key === API_CALL_TOOL_META_KEY ||
      key === API_UPLOAD_TOOL_META_KEY ||
      key === TOOL_INTEGRATION_META_KEY
    ) {
      continue;
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The steps {@link sanitiseToolDescriptor} may take to bring a descriptor within the schema budget, in order. */
export const TOOL_DESCRIPTOR_REDUCTIONS = [
  "output_schema",
  "schema_documentation",
  "input_schema",
] as const;
export type ToolDescriptorReduction = (typeof TOOL_DESCRIPTOR_REDUCTIONS)[number];

/** Keywords that only document a schema: validation never reads them. */
const DOCUMENTATION_KEYWORDS: ReadonlySet<string> = new Set([
  "description",
  "title",
  "examples",
  "$comment",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

/**
 * Keywords whose value maps a name (a property's, a definition's, …) to a schema. Draft-07
 * `dependencies` also maps a name to a property-name array, kept as is like any non-schema value.
 */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
]);

/** Keywords whose value is a schema or an array of schemas. */
const SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "items",
  "additionalItems",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
  "contentSchema",
]);

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `schema` without its documentation keywords ({@link DOCUMENTATION_KEYWORDS} and every `x-*`
 * annotation), at every schema position. Names under a {@link SCHEMA_MAP_KEYWORDS} keyword are
 * not keywords — a property named `description` stays — and every other value (`enum`, `const`,
 * `default`, `required`, …) is kept verbatim. Past {@link MAX_SCHEMA_DEPTH} a subtree is left as is.
 */
function stripSchemaDocumentation(schema: unknown, depth = 0): unknown {
  if (!isSchemaObject(schema) || depth >= MAX_SCHEMA_DEPTH) return schema;
  const strip = (sub: unknown) => stripSchemaDocumentation(sub, depth + 1);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (DOCUMENTATION_KEYWORDS.has(key) || key.startsWith("x-")) continue;
    if (SCHEMA_MAP_KEYWORDS.has(key) && isSchemaObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, strip(sub)]));
    } else if (SUBSCHEMA_KEYWORDS.has(key)) {
      out[key] = Array.isArray(value) ? value.map(strip) : strip(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const encoder = new TextEncoder();

/**
 * Whether the serialised schemas fit {@link MAX_SCHEMA_SERIALISED_BYTES}, counted in UTF-8
 * bytes — `String.length` counts UTF-16 code units, so a schema
 * of multibyte characters could carry up to ~4× the intended budget. Both schemas share one
 * budget: they reach the agent together.
 */
function fitsSchemaBudget(inputSchema: unknown, outputSchema?: unknown): boolean {
  let bytes = encoder.encode(JSON.stringify(inputSchema)).byteLength;
  if (outputSchema !== undefined) bytes += encoder.encode(JSON.stringify(outputSchema)).byteLength;
  return bytes <= MAX_SCHEMA_SERIALISED_BYTES;
}

/** Leads the description of a tool whose input schema is withheld. */
const INPUT_SCHEMA_WITHHELD_NOTE =
  "Input schema withheld, too large to show: the server validates the arguments.";

/**
 * Sanitise a single MCP {@link Tool} descriptor. Returns a fresh copy —
 * never mutates the input — with all known injection vectors stripped
 * and length caps enforced.
 *
 * The sanitised `inputSchema` and `outputSchema` share a budget of
 * {@link MAX_SCHEMA_SERIALISED_BYTES}. A descriptor over it is degraded, never
 * dropped; `reduced` lists, in this order, the steps taken (empty when none
 * was needed):
 *   1. `output_schema`: `outputSchema` is removed (optional in MCP).
 *   2. `schema_documentation`: the input schema loses its documentation
 *      keywords. The tool's own description stays.
 *   3. `input_schema`: the input schema becomes `{ type: "object" }` and the
 *      description says it was withheld and that the server validates the
 *      arguments.
 * The input schema is reduced only as far as it must fit on its own (step 1
 * goes first), and the output schema is kept whenever it fits beside it.
 *
 * `outputSchema` is sanitised and budgeted alongside `inputSchema`: an
 * untrusted server could hide poisoned `description` fields in it, and it is
 * load-bearing — the MCP SDK client validates every result of a tool that
 * declares one — so a hostile or oversized `outputSchema` is not inert.
 */
export function sanitiseToolDescriptor(tool: Tool): {
  tool: Tool;
  reduced: ToolDescriptorReduction[];
} {
  let description = sanitiseTextField(tool.description, MAX_TOOL_DESCRIPTION_BYTES);
  let inputSchema = sanitiseSchemaDescriptions(tool.inputSchema) as Tool["inputSchema"];
  let outputSchema =
    tool.outputSchema === undefined
      ? undefined
      : (sanitiseSchemaDescriptions(tool.outputSchema) as Tool["outputSchema"]);
  const reduced: ToolDescriptorReduction[] = [];
  if (!fitsSchemaBudget(inputSchema, outputSchema)) {
    // The output schema is the first to go: the input schema is reduced only as far as it must
    // fit on its own, and the output schema stays if it still fits beside the result.
    if (!fitsSchemaBudget(inputSchema)) {
      inputSchema = stripSchemaDocumentation(inputSchema) as Tool["inputSchema"];
      reduced.push("schema_documentation");
    }
    if (!fitsSchemaBudget(inputSchema)) {
      inputSchema = { type: "object" };
      // Leading, so the length cap (here, or a renamed tool's) cuts the upstream text, never the note.
      description = sanitiseTextField(
        description
          ? `${INPUT_SCHEMA_WITHHELD_NOTE}\n\n${description}`
          : INPUT_SCHEMA_WITHHELD_NOTE,
        MAX_TOOL_DESCRIPTION_BYTES,
      );
      reduced.push("input_schema");
    }
    if (!fitsSchemaBudget(inputSchema, outputSchema)) {
      outputSchema = undefined;
      reduced.unshift("output_schema");
    }
  }
  const sanitisedMeta = sanitiseToolMeta(tool._meta);
  const { _meta: _untrustedMeta, outputSchema: _upstreamOutput, ...toolWithoutMeta } = tool;
  const out: Tool = {
    ...toolWithoutMeta,
    inputSchema,
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(sanitisedMeta !== undefined ? { _meta: sanitisedMeta } : {}),
  };
  if (typeof tool.title === "string") {
    out.title = sanitiseTextField(tool.title, MAX_PARAMETER_DESCRIPTION_BYTES);
  }
  return { tool: out, reduced };
}

/** The labels whose place in a `_meta` prefix reserves it for MCP. */
const MCP_RESERVED_LABELS: ReadonlySet<string> = new Set(["mcp", "modelcontextprotocol"]);

/**
 * Whether a `_meta` key belongs to a namespace a third-party result has no claim to, its prefix
 * (the part before the first `/`, compared case-insensitively) being:
 *   - the platform's own, `dev.appstrate`;
 *   - reserved for MCP: its second label is `modelcontextprotocol` or `mcp` (MCP's rule:
 *     `io.modelcontextprotocol/`, `dev.mcp/`, `api.modelcontextprotocol.org/`), or its first
 *     label is (AFPS §10.1: `mcp/`, `modelcontextprotocol.io/`).
 * A key with no `/` has no prefix and is never reserved.
 */
function isReservedMetaKey(key: string): boolean {
  const slash = key.indexOf("/");
  if (slash < 0) return false;
  const prefix = key.slice(0, slash).toLowerCase();
  if (prefix === "dev.appstrate") return true;
  const labels = prefix.split(".");
  return MCP_RESERVED_LABELS.has(labels[0]!) || MCP_RESERVED_LABELS.has(labels[1] ?? "");
}

/** `holder` without the reserved keys of its `_meta`, which goes when nothing else is left in it. */
function withoutReservedMeta<T extends { _meta?: Record<string, unknown> }>(holder: T): T {
  const meta = holder._meta;
  if (!meta || typeof meta !== "object") return holder;
  const kept = Object.entries(meta).filter(([key]) => !isReservedMetaKey(key));
  if (kept.length === Object.keys(meta).length) return holder;
  const { _meta: _dropped, ...rest } = holder;
  return (kept.length > 0 ? { ...rest, _meta: Object.fromEntries(kept) } : rest) as T;
}

/**
 * A third-party tool result relayed outside a run, without the reserved `_meta` keys
 * ({@link isReservedMetaKey}) of the result and of each of its content blocks: the platform's
 * runtime events included, and any marker the platform or the protocol would read as its own.
 */
export function stripReservedResultMeta(result: CallToolResult): CallToolResult {
  const stripped = withoutReservedMeta(result);
  if (!Array.isArray(result.content)) return stripped;
  const content = result.content.map((block) => withoutReservedMeta(block));
  return content.every((block, index) => block === result.content[index])
    ? stripped
    : { ...stripped, content };
}
