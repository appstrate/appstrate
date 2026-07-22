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
 *   - Total schema serialised size ≤ 8192 bytes.
 *
 * What this module deliberately does NOT do:
 *   - Block specific phrases ("IGNORE PREVIOUS"). The LLM's own
 *     instruction-tuning is the right line of defence for content; we
 *     just keep the sanitised payload below sizes that overwhelm it.
 *   - Round-trip the schema through a strict JSON Schema validator —
 *     that's a registry-boundary concern, enforced at publish time.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  API_CALL_TOOL_META_KEY,
  API_UPLOAD_TOOL_META_KEY,
  DESKTOP_DOWNLOAD_TOOL_META_KEY,
  DESKTOP_BATCH_TOOL_META_KEY,
} from "./tool-meta.ts";

export const MAX_TOOL_DESCRIPTION_BYTES = 2048;
export const MAX_PARAMETER_DESCRIPTION_BYTES = 512;
export const MAX_SCHEMA_SERIALISED_BYTES = 8192;

/**
 * Hidden-Unicode code points frequently used to smuggle prompt-injection
 * payloads. We strip every entry in this set before any length
 * accounting so attackers can't pack bytes into otherwise-empty space.
 *
 * Built with `new RegExp(...)` and `\uXXXX` escapes so the source file
 * itself stays free of the very characters we're trying to defeat.
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
 */
// Hidden code points stripped on every text field. Encoded as a
// per-code-point predicate (not a regex character class) because some
// adjacent fillers — e.g. Hangul ᅟ + ᅠ — render as a single
// combined glyph and trip eslint's no-misleading-character-class rule.
function isHiddenCodePoint(cp: number): boolean {
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
    cp === 0xffa0
  );
}

function stripHiddenCodePoints(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const cp = value.charCodeAt(i);
    if (!isHiddenCodePoint(cp)) out += value[i];
  }
  return out;
}

/**
 * C0 control characters (U+0000-U+001F) plus DEL (U+007F), with `\n`
 * and `\t` preserved. Built via constructor + escapes for the same
 * reason as HIDDEN_UNICODE_RE.
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
 * the serialised-size cap in {@link sanitiseToolDescriptor} still bounds the
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
 * could make it impersonate the sidecar's credential proxy or upload sibling.
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
      key === DESKTOP_DOWNLOAD_TOOL_META_KEY ||
      key === DESKTOP_BATCH_TOOL_META_KEY
    )
      continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Sanitise a single MCP {@link Tool} descriptor. Returns a fresh copy —
 * never mutates the input — with all known injection vectors stripped
 * and length caps enforced.
 *
 * Drops the tool entirely (returns `null`) when the resulting schemas
 * are too large after sanitisation. The host should log this and refuse
 * to advertise the tool to the agent rather than ship a half-sanitised
 * descriptor.
 *
 * `outputSchema` is sanitised and budgeted alongside `inputSchema`. It
 * used to ride through untouched on the `...tool` spread: an untrusted
 * server could hide poisoned `description` fields in it and blow past the
 * size cap, which only weighed `inputSchema`. It is also load-bearing —
 * the MCP SDK client validates every result of a tool that declares one —
 * so a hostile or oversized `outputSchema` is not inert.
 */
export function sanitiseToolDescriptor(tool: Tool): Tool | null {
  const description = sanitiseTextField(tool.description, MAX_TOOL_DESCRIPTION_BYTES);
  const inputSchema = sanitiseSchemaDescriptions(tool.inputSchema) as Tool["inputSchema"];
  const outputSchema =
    tool.outputSchema === undefined
      ? undefined
      : (sanitiseSchemaDescriptions(tool.outputSchema) as Tool["outputSchema"]);
  const sanitisedMeta = sanitiseToolMeta(tool._meta);
  // Measure the UTF-8 byte length — `String.length` counts UTF-16 code units,
  // so a schema of multibyte characters could carry up to ~4× the intended
  // byte budget past this cap. Both schemas share one budget: they reach the
  // agent together.
  const encoder = new TextEncoder();
  let serialisedBytes = encoder.encode(JSON.stringify(inputSchema)).byteLength;
  if (outputSchema !== undefined) {
    serialisedBytes += encoder.encode(JSON.stringify(outputSchema)).byteLength;
  }
  if (serialisedBytes > MAX_SCHEMA_SERIALISED_BYTES) return null;
  const { _meta: _untrustedMeta, ...toolWithoutMeta } = tool;
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
  return out;
}
