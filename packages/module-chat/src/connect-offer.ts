// SPDX-License-Identifier: Apache-2.0

/**
 * Connect-offer redaction + extraction — the single walk the chat engine uses
 * on tool results that may carry a connect/authorize URL.
 *
 * A connect URL must exist in exactly one place per channel:
 *
 *  - MODEL channel — never. Every `connect_url`/`auth_url` string is replaced
 *    by {@link REDACTED_CONNECT_LINK} so the model cannot paste a link it never
 *    receives.
 *  - UI channel — only in the typed `connectOffers` field the splitters attach
 *    to the tool output. The connect cards read that field; they never scrape
 *    the payload (issue #906: the scraper used to grab the placeholder from the
 *    model channel and render it as a relative URL).
 *
 * Redaction and extraction are the SAME pass (`splitValue`): whatever gets
 * scrubbed from the payload is what surfaces as the offer, so the two can never
 * drift apart.
 *
 * A payload may carry SEVERAL connect URLs — a readiness error listing two
 * unconnected integrations carries one link each — so the walk captures every
 * one of them, in walk order, deduped by normalized URL. Capturing only the
 * first scrubbed the rest for the UI as well as for the model (issue #1207).
 *
 * `ui/auth-offer.ts` (bundled into the SPA) imports the {@link ConnectOffer}
 * type and {@link readConnectOffers} from here, so this module may only pull in
 * client-safe leaf imports — never server-only modules (MCP client, logger).
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
 * `bun run check` has no HTTP-response casing check at all — `verify:openapi`
 * performs none, and `lint:manifest-casing` covers AFPS manifests, not HTTP
 * responses. The two spellings above are what `apps/api/src/routes/
 * integrations.ts` returns — `{ auth_url, state }` for Porte B and
 * `{ connect_url, expires_at }` for Porte A — the latter also declared
 * `required: ["connect_url", "expires_at"]` in `apps/api/src/openapi/paths/
 * integrations.ts`. `verify:openapi` asserts that endpoint is documented and
 * that its 2xx response declares a schema; it does NOT diff the declared keys
 * against what the handler emits, so the route and the declaration are the
 * pair to re-read if this set ever looks wrong.
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
 * Offers collected by one walk, in walk order. `seen` holds the normalized URLs
 * already captured, so the same link appearing twice in a payload (a summary
 * block repeating a detail block) yields one card, not two.
 */
interface OfferSink {
  offers: ConnectOffer[];
  seen: Set<string>;
}

/**
 * Build an offer from the node whose connect key just got redacted. Siblings
 * are read under their wire spelling only — same reason as
 * {@link CONNECT_URL_KEYS}: `expires_at` is what Porte A returns beside
 * `connect_url`, and nothing on this path emits a camelCase twin.
 *
 * `expires_at` is worth naming explicitly, because the general policy points
 * the other way: `docs/CASING_CONVENTIONS.md` carve-out 4b lists `expiresAt`
 * among the DB-convention fields that stay camelCase everywhere INCLUDING the
 * wire. This endpoint does not follow that carve-out — it emits `expires_at`,
 * as the OpenAPI response schema for `POST …/connect/start` requires and as
 * `routes/integrations.ts` writes — and the same document's internal
 * sidecar↔platform section lists `expires_at` too. A reader follows what the
 * endpoint emits, not the carve-out; the tension is in the policy document,
 * and reconciling it there is out of this module's scope.
 */
function captureOffer(sink: OfferSink, obj: Record<string, unknown>, url: string): void {
  if (sink.seen.has(url)) return;
  sink.seen.add(url);
  sink.offers.push(offerFromNode(obj, url));
}

function offerFromNode(obj: Record<string, unknown>, url: string): ConnectOffer {
  const state = typeof obj.state === "string" ? obj.state : undefined;
  const expiresAt = typeof obj.expires_at === "number" ? obj.expires_at : undefined;
  const packageId = typeof obj.package_id === "string" ? obj.package_id : undefined;
  return {
    connect_url: url,
    ...(state !== undefined ? { state } : {}),
    ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
    ...(packageId !== undefined ? { package_id: packageId } : {}),
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
      if (connectUrl) captureOffer(sink, obj, connectUrl);
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
  const sink: OfferSink = { offers: [], seen: new Set() };
  const r = splitValue(value, 0, sink);
  return { ...r, offers: sink.offers };
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
  return splitWithOffers(payload).value;
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
 * `connect_url`. Each splitter already dedupes within its own payload; this is
 * the cross-source merge `mcpResultToPi` needs across a result's text blocks.
 */
export function mergeConnectOffers(...lists: ConnectOffer[][]): ConnectOffer[] {
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
  return {
    connect_url: connectUrl,
    ...(typeof o.state === "string" ? { state: o.state } : {}),
    ...(typeof o.expires_at === "number" ? { expires_at: o.expires_at } : {}),
    ...(typeof o.package_id === "string" ? { package_id: o.package_id } : {}),
  };
}
