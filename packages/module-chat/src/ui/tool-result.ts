// SPDX-License-Identifier: Apache-2.0

/**
 * Pure (React-free, unit-testable) helpers for interpreting MCP tool-call
 * results in the chat UI.
 *
 * A tool `result` reaches us in one of several envelopes depending on the
 * runtime/bridge path — raw MCP `CallToolResult` `{ content: [{ type:"text",
 * text }] }`, the AI-SDK bridge `{ type:"content", value:[…] }` / `{ type:"json",
 * value }`, a bare content array, or a JSON string. `unwrapResult` peels these
 * layers down to the actual payload so the rest of the UI never has to know
 * which path produced it.
 *
 * (`auth-offer.ts` keeps its own deep *search* walker — it looks for an
 * `auth_url` anywhere in the tree, a different job from peeling to the single
 * payload here.)
 */

/** Lifecycle phase of a tool call, derived from status + result. */
export type ToolPhase = "pending" | "running" | "success" | "error";

/** Subset of an assistant-ui tool-call part we need to derive a phase. */
interface ToolPhaseInput {
  status?: { type?: string; reason?: string } | undefined;
  isError?: boolean | undefined;
  result?: unknown;
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

/**
 * Peel the runtime/bridge envelopes off a tool result, returning the inner
 * payload (parsed when it arrives as a JSON string). Depth-bounded so a
 * pathological structure can't loop.
 */
export function unwrapResult(value: unknown, depth = 0): unknown {
  if (depth > 8 || value == null) return value;

  if (typeof value === "string") {
    const s = value.trim();
    if (s[0] === "{" || s[0] === "[") {
      try {
        return unwrapResult(JSON.parse(s), depth + 1);
      } catch {
        return value;
      }
    }
    return value;
  }

  if (Array.isArray(value)) {
    // MCP content array of text parts → concat the text and parse.
    const texts = value.filter(isTextPart).map((p) => p.text);
    if (texts.length > 0) return unwrapResult(texts.join(""), depth + 1);
    if (value.length === 1) return unwrapResult(value[0], depth + 1);
    return value;
  }

  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (Array.isArray(o.content)) return unwrapResult(o.content, depth + 1);
    if (o.type === "json" && "value" in o) return unwrapResult(o.value, depth + 1);
    if (o.type === "content" && "value" in o) return unwrapResult(o.value, depth + 1);
    if (o.type === "text" && typeof o.text === "string") return unwrapResult(o.text, depth + 1);
    return o;
  }

  return value;
}

/** Plain-object view of a value, or null when it isn't a record. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** HTTP status carried by an unwrapped result, when present. */
export function httpStatusOf(unwrapped: unknown): number | undefined {
  const rec = asRecord(unwrapped);
  return typeof rec?.status === "number" ? rec.status : undefined;
}

/** Whether an unwrapped payload represents a failure. */
function isErrorPayload(unwrapped: unknown): boolean {
  const rec = asRecord(unwrapped);
  if (!rec) return false;
  if (rec.outcome === "denied" || rec.outcome === "rejected") return true;
  if (typeof rec.status === "number" && rec.status >= 400) return true;
  if (typeof rec.error === "string" && rec.error.length > 0) return true;
  // McpError shape: { code:number, message:string }.
  if (typeof rec.code === "number" && typeof rec.message === "string") return true;
  return false;
}

/**
 * Single source of truth for a tool call's phase. Combines assistant-ui status,
 * the part's `isError` flag, and the unwrapped payload (HTTP ≥ 400, `outcome`,
 * embedded `error`) so a failed call can never read as a success.
 */
export function deriveToolPhase(part: ToolPhaseInput): ToolPhase {
  const type = part.status?.type;
  if (type === "running") return "running";
  if (type === "requires-action") return "pending";
  if (part.isError === true) return "error";
  if (type === "incomplete") return "error";
  if (isErrorPayload(unwrapResult(part.result))) return "error";
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
  const rec = asRecord(unwrapped);
  if (!rec) return typeof unwrapped === "string" ? unwrapped : undefined;

  const direct = pickMessage(rec);
  if (direct) return direct;

  if (typeof rec.status === "number" && rec.status >= 400) {
    if (typeof rec.body === "string" && rec.body) return rec.body;
    const fromBody = pickMessage(asRecord(rec.body));
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
