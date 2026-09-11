// SPDX-License-Identifier: Apache-2.0

/**
 * Connect-offer redaction + extraction — the single walk the chat engine uses
 * on tool results that may carry a connect/authorize URL.
 *
 * A connect URL exists in exactly one place per channel: never in the MODEL
 * channel (every `connect_url`/`auth_url` string is replaced by
 * {@link REDACTED_CONNECT_LINK}), and for the UI only in the typed
 * `connectOffers` field the splitters attach to the tool output — the connect
 * cards read that field, never the payload (issue #906). Redaction and
 * extraction are the SAME pass (`splitValue`), so the two cannot drift apart.
 *
 * A payload may carry SEVERAL connect URLs — a readiness error lists one per
 * unconnected integration — so the walk captures every one, in walk order,
 * deduped by normalized URL (issue #1207).
 *
 * `ui/auth-offer.ts` (bundled into the SPA) imports from here, so this module
 * may only pull in client-safe leaf imports — never server-only ones (MCP
 * client, logger).
 */

import { normalizeHttpUrl } from "@appstrate/core/url";

/**
 * Placeholder that replaces a connect/authorize URL in the MODEL-visible tool
 * output. The model can't paste a link it never receives; the UI renders the
 * native connect cards from the typed `connectOffers` field instead.
 */
export const REDACTED_CONNECT_LINK = "[connect link hidden — the chat renders the connect card]";

/**
 * Field names carrying a connect/authorize URL. Exactly the two the platform
 * emits — `auth_url` (Porte B, the headless OAuth2 start) and `connect_url`
 * (Porte A, the hosted Connect portal), both in `routes/integrations.ts`.
 *
 * Two, and no camelCase twin, because this walk only ever sees Appstrate's own
 * wire: the chat opens ONE MCP connection, to the platform's own org-scoped
 * endpoint (`platform-mcp.ts`), dispatched in-process through the REST
 * pipeline — there is no third-party MCP server in this path whose casing this
 * set would have to tolerate. And a spelling-based denylist could not be a
 * foreign-payload safety net anyway: a stranger is as free to call the field
 * `url` or `href`.
 *
 * What pins the spelling is the endpoints themselves, not a casing gate:
 * `bun run check` has no HTTP-response casing check at all. The two spellings
 * above are what `apps/api/src/routes/integrations.ts` returns, and
 * `verify:openapi` does NOT diff the declared keys against what the handler
 * emits — so the route and its OpenAPI declaration are the pair to re-read if
 * this set ever looks wrong.
 */
const CONNECT_URL_KEYS = new Set(["connect_url", "auth_url"]);

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
  /** Porte B (the headless OAuth2 start) pairs `auth_url` with a correlation `state`. */
  state?: string;
  expires_at?: number;
  /**
   * Integration the link connects (`@scope/name`). A run-kickoff 412 item
   * (#1207) pairs it with `connect_url`; the card uses it for the integration's
   * icon and display name, and to claim the resume append.
   */
  package_id?: string;
}

interface SplitResult {
  /** Redacted value; the ORIGINAL reference when nothing changed (prompt-cache friendly). */
  value: unknown;
  changed: boolean;
}

/**
 * Where one walk pushes its offers, in walk order and undeduped — dedupe lives
 * in {@link mergeConnectOffers} alone. `null` on the redact-only path, which
 * then builds no offer at all.
 */
type OfferSink = ConnectOffer[] | null;

/**
 * Optional offer fields, read under their wire spelling only — same reason as
 * {@link CONNECT_URL_KEYS}. `expires_at` is worth naming: carve-out 4b of
 * `docs/CASING_CONVENTIONS.md` keeps `expiresAt` camelCase even on the wire,
 * but this endpoint emits `expires_at`, as its OpenAPI response schema
 * requires; a reader follows the endpoint, not the carve-out.
 */
function pickOfferFields(obj: Record<string, unknown>): Omit<ConnectOffer, "connect_url"> {
  return {
    ...(typeof obj.state === "string" ? { state: obj.state } : {}),
    ...(typeof obj.expires_at === "number" ? { expires_at: obj.expires_at } : {}),
    ...(typeof obj.package_id === "string" ? { package_id: obj.package_id } : {}),
  };
}

/**
 * Deep-walk `value`, replacing every `connect_url`/`auth_url` string with the
 * placeholder and capturing each absolute-URL offer into `sink`. When nothing
 * changed the original reference is returned so callers can keep text
 * byte-identical (prompt caching).
 */
function splitValue(value: unknown, depth: number, sink: OfferSink): SplitResult {
  if (depth > MAX_REDACT_DEPTH || value == null || typeof value !== "object") {
    return { value, changed: false };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const r = splitValue(item, depth + 1, sink);
      if (r.changed) changed = true;
      return r.value;
    });
    return changed ? { value: out, changed: true } : { value, changed: false };
  }

  const obj = value as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) {
    if (CONNECT_URL_KEYS.has(key) && typeof v === "string") {
      out[key] = REDACTED_CONNECT_LINK;
      changed = true;
      // Capture only parsed absolute HTTP(S) URLs — an already-redacted
      // placeholder, malformed value or other scheme is scrubbed but never
      // offered. Persist the same normalized href the browser will navigate.
      const connectUrl = normalizeHttpUrl(v);
      if (connectUrl) sink?.push({ connect_url: connectUrl, ...pickOfferFields(obj) });
      continue;
    }
    const r = splitValue(v, depth + 1, sink);
    if (r.changed) changed = true;
    out[key] = r.value;
  }
  return changed ? { value: out, changed: true } : { value, changed: false };
}

/** One walk with a fresh sink — the shape every exported splitter builds on. */
function splitWithOffers(value: unknown): SplitResult & { offers: ConnectOffer[] } {
  const sink: ConnectOffer[] = [];
  const r = splitValue(value, 0, sink);
  return { ...r, offers: mergeConnectOffers([sink]) };
}

/**
 * Split an arbitrary (already parsed) payload: redacted copy + every offer it
 * carried, in walk order. `redacted` is the same reference when nothing changed.
 */
export function splitConnectPayload(payload: unknown): {
  redacted: unknown;
  offers: ConnectOffer[];
} {
  const r = splitWithOffers(payload);
  return { redacted: r.value, offers: r.offers };
}

/** Redact-only view of {@link splitConnectPayload} (model-channel scrubbing). */
export function redactConnectPayload(payload: unknown): unknown {
  return splitValue(payload, 0, null).value;
}

/**
 * Split a text block that may hold a JSON payload: parses, redacts, and
 * re-stringifies ONLY when something changed — non-JSON text passes through
 * byte-identical, never regex-mangled.
 */
export function splitJsonText(text: string): { text: string; offers: ConnectOffer[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text, offers: [] };
  }
  const r = splitWithOffers(parsed);
  return { text: r.changed ? JSON.stringify(r.value) : text, offers: r.offers };
}

/**
 * Concatenate offer lists in order, keeping the first entry per normalized
 * `connect_url`. The ONE dedupe rule: a single walk's offers pass through here
 * too ({@link splitWithOffers}), and `mcpResultToPi` uses it to merge across a
 * result's text blocks.
 */
export function mergeConnectOffers(lists: readonly ConnectOffer[][]): ConnectOffer[] {
  const seen = new Set<string>();
  const out: ConnectOffer[] = [];
  for (const list of lists) {
    for (const offer of list) {
      if (seen.has(offer.connect_url)) continue;
      seen.add(offer.connect_url);
      out.push(offer);
    }
  }
  return out;
}

/**
 * Read the typed `connectOffers` off a persisted tool output (top level, or one
 * `output` level down for bridges that nest the result). Shape-checked — this
 * is the ONLY sanctioned way for the UI to obtain connect URLs from a tool
 * result produced after the typed channel shipped.
 */
export function readConnectOffers(result: unknown): ConnectOffer[] {
  if (result == null || typeof result !== "object") return [];
  const o = result as Record<string, unknown>;
  const direct = asConnectOffers(o.connectOffers);
  if (direct.length > 0) return direct;
  if (o.output != null && typeof o.output === "object") {
    return asConnectOffers((o.output as Record<string, unknown>).connectOffers);
  }
  return [];
}

function asConnectOffers(value: unknown): ConnectOffer[] {
  if (!Array.isArray(value)) return [];
  const out: ConnectOffer[] = [];
  for (const item of value) {
    const offer = asConnectOffer(item);
    if (offer) out.push(offer);
  }
  return out;
}

function asConnectOffer(value: unknown): ConnectOffer | null {
  if (value == null || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const connectUrl = normalizeHttpUrl(o.connect_url);
  if (!connectUrl) return null;
  return { connect_url: connectUrl, ...pickOfferFields(o) };
}
