// SPDX-License-Identifier: Apache-2.0

/**
 * Pure (React-free, unit-testable) helpers for interpreting MCP tool-call
 * results in the chat UI.
 *
 * A tool `result` reaches us as a raw MCP `CallToolResult`
 * `{ content: [{ type:"text", text }] }`, a bare content array, or a JSON
 * string. `unwrapMcpResult` (`@appstrate/core/mcp-result`) peels those layers down
 * to the actual payload so the rest of the UI never has to know which shape arrived.
 *
 * It does NOT peel the AI-SDK `ToolResultOutput` envelopes
 * `{ type:"json", value }` / `{ type:"content", value }`, and that is a checked
 * decision rather than an oversight — an unpeeled envelope would be harmful
 * (`isErrorPayload` reads `status`/`error` at the top level, misses them inside
 * `value`, and a FAILED call renders as a success), so "arbitrary MCP servers
 * emit whatever they like" is not on its own a reason to keep the peeling. What
 * decides it is that no such value can reach `part.result`:
 *
 *   - every tool the chat exposes is registered by `pi-chat/mcp-tools.ts`, and
 *     BOTH constructors there (`toPiToolResult`, `mcpResultToPi`) return Pi's
 *     `{ content: [{type:"text",…}], details? }` shape. An arbitrary server's
 *     `CallToolResult` is normalized by `mcpResultToPi` — every block becomes a
 *     text block — before it is ever handed to the UI-stream mapper;
 *   - that platform MCP client is the ONLY tool source: the engine builds the
 *     session with `noTools: "builtin"` and a resource loader that disables
 *     extension, skill and prompt discovery, so nothing else can register a
 *     tool whose result would bypass those two constructors;
 *   - and nothing ever persisted one either — the retired ai-sdk path stored
 *     each tool's `execute` result (already `{ content: […] }`), while these
 *     envelopes were the model-facing `toModelOutput` channel, which never
 *     reached a UIMessage. A repo-wide search finds no producer.
 *
 * The one residue is a server that puts that literal JSON *inside* a text
 * block. Peeling it would be guessing at a foreign server's semantics, not
 * removing an Appstrate envelope, so it stays unpeeled.
 */

import { asRecordOrNull } from "@appstrate/core/safe-json";
import { unwrapMcpResult } from "@appstrate/core/mcp-result";

/** Lifecycle phase of a tool call, derived from status + result. */
export type ToolPhase = "pending" | "running" | "success" | "error";

/** Subset of an assistant-ui tool-call part we need to derive a phase. */
interface ToolPhaseInput {
  status?: { type?: string; reason?: string } | undefined;
  isError?: boolean | undefined;
  result?: unknown;
}

/** HTTP status carried by an unwrapped result, when present. */
export function httpStatusOf(unwrapped: unknown): number | undefined {
  const rec = asRecordOrNull(unwrapped);
  return typeof rec?.status === "number" ? rec.status : undefined;
}

/**
 * Whether an unwrapped payload represents a failure. `outcome` is telemetry,
 * never a result field: a rejected call arrives as a thrown `McpError`, caught
 * by the `{ code, message }` branch below.
 */
function isErrorPayload(unwrapped: unknown): boolean {
  const rec = asRecordOrNull(unwrapped);
  if (!rec) return false;
  if (typeof rec.status === "number" && rec.status >= 400) return true;
  if (typeof rec.error === "string" && rec.error.length > 0) return true;
  // McpError shape: { code:number, message:string }.
  if (typeof rec.code === "number" && typeof rec.message === "string") return true;
  return false;
}

/**
 * Single source of truth for a tool call's phase. Combines assistant-ui status,
 * the part's `isError` flag, and the unwrapped payload (HTTP ≥ 400, embedded
 * `error`) so a failed call can never read as a success.
 */
export function deriveToolPhase(part: ToolPhaseInput): ToolPhase {
  const type = part.status?.type;
  if (type === "running") return "running";
  if (type === "requires-action") return "pending";
  if (part.isError === true) return "error";
  if (type === "incomplete") return "error";
  if (isErrorPayload(unwrapMcpResult(part.result))) return "error";
  if (part.result === undefined) return type === "complete" ? "success" : "pending";
  return "success";
}

// Message-bearing keys in priority order. RFC 9457 problem+json leads with
// `detail`/`title`; generic API errors use `message`/`error`; OAuth uses
// `error_description`.
const MESSAGE_KEYS = ["detail", "title", "message", "error", "error_description"];

function pickMessage(rec: Record<string, unknown> | null): string | undefined {
  if (!rec) return undefined;
  for (const k of MESSAGE_KEYS) {
    const v = rec[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/**
 * Human-readable error message from an unwrapped failure payload. Looks at the
 * top level first, then digs into the HTTP `body` (the real error for a 4xx/5xx
 * lives there — e.g. a problem+json `{ title, detail }`), only falling back to
 * a bare `HTTP <status>` when nothing carries a message.
 */
export function extractErrorMessage(unwrapped: unknown): string | undefined {
  const rec = asRecordOrNull(unwrapped);
  if (!rec) return typeof unwrapped === "string" ? unwrapped : undefined;

  const direct = pickMessage(rec);
  if (direct) return direct;

  if (typeof rec.status === "number" && rec.status >= 400) {
    if (typeof rec.body === "string" && rec.body) return rec.body;
    const fromBody = pickMessage(asRecordOrNull(rec.body));
    if (fromBody) return fromBody;
    return `HTTP ${rec.status}`;
  }
  return undefined;
}

/** Pick the defined entries of a record (drops undefined/null) for display. */
export function definedEntries(
  source: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!source) return out;
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}
