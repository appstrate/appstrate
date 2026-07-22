// SPDX-License-Identifier: Apache-2.0

/**
 * Connect-offer redaction + extraction — the single walk both chat engines use
 * on tool results that may carry a connect/authorize URL.
 *
 * A connect URL must exist in exactly one place per channel:
 *
 *  - MODEL channel — never. Every `connect_url`/`auth_url` string is replaced
 *    by {@link REDACTED_CONNECT_LINK} so the model cannot paste a link it never
 *    receives.
 *  - UI channel — only in the typed `connectOffer` field the splitters attach
 *    to the tool output. The connect card reads that field; it never scrapes
 *    the payload (issue #906: the scraper used to grab the placeholder from the
 *    model channel and render it as a relative URL).
 *
 * Redaction and extraction are the SAME pass (`splitValue`): whatever gets
 * scrubbed from the payload is what surfaces as the offer, so the two can never
 * drift apart.
 *
 * Dependency-free on purpose: `ui/auth-offer.ts` (bundled into the SPA) imports
 * the {@link ConnectOffer} type and {@link readConnectOffer} from here, so this
 * module must not pull in server-only imports (MCP client, logger).
 */

/**
 * Placeholder that replaces a connect/authorize URL in the MODEL-visible tool
 * output. The model can't paste a link it never receives; the UI renders the
 * native connect card from the typed `connectOffer` field instead.
 */
export const REDACTED_CONNECT_LINK = "[connect link hidden — the chat renders the connect card]";

/** Field names carrying a connect/authorize URL (snake + camel). */
const CONNECT_URL_KEYS = new Set(["connect_url", "auth_url", "connectUrl", "authUrl"]);

/** Depth bound for the redaction walk — MCP payloads are shallow. */
const MAX_REDACT_DEPTH = 16;

/**
 * Typed connect offer captured while redacting. Keys are wire-shaped
 * (snake_case, straight off the platform payload) — deliberately so: the inner
 * `connect_url` key is itself in {@link CONNECT_URL_KEYS}, so if an offer
 * object ever strays through the redactor again it gets scrubbed rather than
 * leaked.
 */
export interface ConnectOffer {
  /** Absolute http(s) URL — validated at capture time. */
  connect_url: string;
  /** Legacy OAuth flows pair `auth_url` with a correlation `state`. */
  state?: string;
  expires_at?: number;
}

interface SplitResult {
  /** Redacted value; the ORIGINAL reference when nothing changed (prompt-cache friendly). */
  value: unknown;
  changed: boolean;
  /** First valid offer found, in walk order. */
  offer: ConnectOffer | null;
}

/** Build an offer from the node whose connect key just got redacted. */
function offerFromNode(obj: Record<string, unknown>, url: string): ConnectOffer {
  const state = typeof obj.state === "string" ? obj.state : undefined;
  const expiresAt =
    typeof obj.expires_at === "number"
      ? obj.expires_at
      : typeof obj.expiresAt === "number"
        ? obj.expiresAt
        : undefined;
  return {
    connect_url: url,
    ...(state !== undefined ? { state } : {}),
    ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
  };
}

/**
 * Deep-walk `value`, replacing any `connect_url`/`auth_url`/`connectUrl`/`authUrl`
 * string with the placeholder and capturing the first absolute-URL offer. When
 * nothing changed the original reference is returned so callers can keep text
 * byte-identical (prompt caching).
 */
function splitValue(value: unknown, depth: number): SplitResult {
  if (depth > MAX_REDACT_DEPTH || value == null || typeof value !== "object") {
    return { value, changed: false, offer: null };
  }

  if (Array.isArray(value)) {
    let changed = false;
    let offer: ConnectOffer | null = null;
    const out = value.map((item) => {
      const r = splitValue(item, depth + 1);
      if (r.changed) changed = true;
      offer ??= r.offer;
      return r.value;
    });
    return changed ? { value: out, changed: true, offer } : { value, changed: false, offer };
  }

  const obj = value as Record<string, unknown>;
  let changed = false;
  let offer: ConnectOffer | null = null;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) {
    if (CONNECT_URL_KEYS.has(key) && typeof v === "string") {
      out[key] = REDACTED_CONNECT_LINK;
      changed = true;
      // Capture only real absolute URLs — an already-redacted placeholder (or
      // any other prose under a connect key) is scrubbed but never offered.
      if (!offer && /^https?:\/\//.test(v)) offer = offerFromNode(obj, v);
      continue;
    }
    const r = splitValue(v, depth + 1);
    if (r.changed) changed = true;
    offer ??= r.offer;
    out[key] = r.value;
  }
  return changed ? { value: out, changed: true, offer } : { value, changed: false, offer };
}

/**
 * Split an arbitrary (already parsed) payload: redacted copy + first offer.
 * `redacted` is the same reference when nothing changed.
 */
export function splitConnectPayload(payload: unknown): {
  redacted: unknown;
  offer: ConnectOffer | null;
} {
  const r = splitValue(payload, 0);
  return { redacted: r.value, offer: r.offer };
}

/** Redact-only view of {@link splitConnectPayload} (model-channel scrubbing). */
export function redactConnectPayload(payload: unknown): unknown {
  return splitValue(payload, 0).value;
}

/**
 * Split a text block that may hold a JSON payload: parses, redacts, and
 * re-stringifies ONLY when something changed — non-JSON text passes through
 * byte-identical, never regex-mangled.
 */
export function splitJsonText(text: string): { text: string; offer: ConnectOffer | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text, offer: null };
  }
  const r = splitValue(parsed, 0);
  return { text: r.changed ? JSON.stringify(r.value) : text, offer: r.offer };
}

/**
 * Redact connect links from a `toModelOutput` result. The AI SDK v7
 * `ToolResultOutput` union is `text | json | content | error-text | error-json |
 * execution-denied`; the MCP client's `mcpToModelOutput` only ever emits `json`
 * or `content`, so those are the live shapes here. `text` (a top-level string
 * value) is covered too as belt-and-braces — a `toModelOutput` returning it must
 * not slip a connect link past the model-channel scrub. The `error-*` variants
 * are produced by the SDK itself (never routed through `toModelOutput`), and
 * `execution-denied` carries only a denial reason, so neither reaches this walk.
 * Pure, redact-only — the model channel never gets a `connectOffer` field. For
 * `text`/`content` text we only touch valid JSON (re-stringified only when
 * something changed); anything else is returned as-is.
 */
export function redactConnectLinks(output: unknown): unknown {
  if (output == null || typeof output !== "object") return output;
  const o = output as Record<string, unknown>;

  if (o.type === "json") {
    const r = splitValue(o.value, 0);
    return r.changed ? { ...o, value: r.value } : output;
  }

  if (o.type === "text" && typeof o.value === "string") {
    const r = splitJsonText(o.value);
    return r.text === o.value ? output : { ...o, value: r.text };
  }

  if (o.type === "content" && Array.isArray(o.value)) {
    let changed = false;
    const nextValue = o.value.map((part) => {
      if (part == null || typeof part !== "object") return part;
      const p = part as Record<string, unknown>;
      if (p.type !== "text" || typeof p.text !== "string") return part;
      const r = splitJsonText(p.text);
      if (r.text === p.text) return part;
      changed = true;
      return { ...p, text: r.text };
    });
    return changed ? { ...o, value: nextValue } : output;
  }

  return output;
}

/**
 * Split a tool `execute` result for the UI/persistence channel: redact every
 * connect link in place and attach the captured offer as a typed top-level
 * `connectOffer` field. Handles the two shapes `@ai-sdk/mcp` `execute` returns —
 * the raw MCP `CallToolResult` `{content:[…], structuredContent?}` (also on
 * `isError`), or a bare `structuredContent` payload object when an
 * `outputSchema` is configured. Returns the original reference when nothing
 * changed.
 */
export function splitToolResult(result: unknown): unknown {
  if (result == null || typeof result !== "object") return result;
  const o = result as Record<string, unknown>;

  if (Array.isArray(o.content)) {
    let changed = false;
    let offer: ConnectOffer | null = null;
    const content = o.content.map((part) => {
      if (part == null || typeof part !== "object") return part;
      const p = part as Record<string, unknown>;
      if (p.type !== "text" || typeof p.text !== "string") return part;
      const r = splitJsonText(p.text);
      offer ??= r.offer;
      if (r.text === p.text) return part;
      changed = true;
      return { ...p, text: r.text };
    });
    let structuredContent = o.structuredContent;
    if (structuredContent !== undefined) {
      const sc = splitConnectPayload(structuredContent);
      if (sc.redacted !== structuredContent) changed = true;
      // structuredContent is the canonical payload — its offer wins.
      if (sc.offer) offer = sc.offer;
      structuredContent = sc.redacted;
    }
    if (!changed) return result;
    return {
      ...o,
      content,
      ...(o.structuredContent !== undefined ? { structuredContent } : {}),
      ...(offer ? { connectOffer: offer } : {}),
    };
  }

  const r = splitConnectPayload(result);
  if (r.redacted === result) return result;
  return {
    ...(r.redacted as Record<string, unknown>),
    ...(r.offer ? { connectOffer: r.offer } : {}),
  };
}

/**
 * Read the typed `connectOffer` off a persisted tool output (top level, or one
 * `output` level down for bridges that nest the result). Shape-checked — this
 * is the ONLY sanctioned way for the UI to obtain a connect URL from a tool
 * result produced after the typed channel shipped.
 */
export function readConnectOffer(result: unknown): ConnectOffer | null {
  if (result == null || typeof result !== "object") return null;
  const o = result as Record<string, unknown>;
  const direct = asConnectOffer(o.connectOffer);
  if (direct) return direct;
  if (o.output != null && typeof o.output === "object") {
    return asConnectOffer((o.output as Record<string, unknown>).connectOffer);
  }
  return null;
}

function asConnectOffer(value: unknown): ConnectOffer | null {
  if (value == null || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (typeof o.connect_url !== "string" || !/^https?:\/\//.test(o.connect_url)) return null;
  return {
    connect_url: o.connect_url,
    ...(typeof o.state === "string" ? { state: o.state } : {}),
    ...(typeof o.expires_at === "number" ? { expires_at: o.expires_at } : {}),
  };
}
