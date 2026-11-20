// SPDX-License-Identifier: Apache-2.0

/**
 * Connect-offer redaction + extraction — the single walk the chat engine uses
 * on tool results that may carry a connect/authorize URL.
 *
 * A connect URL exists in exactly one place per channel: never in the MODEL
 * channel (every `connect_url`/`auth_url` string is replaced by
 * {@link REDACTED_CONNECT_LINK}), and for the UI only in the typed
 * `connectOffers` field the splitters attach to the tool output — the connect
 * cards read that field, never the payload. Redaction and
 * extraction are the SAME pass (`splitValue`), so the two cannot drift apart.
 *
 * A payload may carry SEVERAL connect URLs — a readiness error lists one per
 * unconnected integration — so the walk captures every one, in walk order,
 * deduped by normalized URL.
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
 * Two, and no camelCase twin, because an offer is only ever read from
 * Appstrate's own wire: the chat opens ONE MCP connection, to the platform's
 * own org-scoped endpoint (`platform-mcp.ts`), dispatched in-process through
 * the REST pipeline. Not all of what comes back is the platform's own words:
 * the integration tools relay an upstream's answers, a run's result is its
 * agent's, a file its author's. A card comes only from the tools and the
 * subtrees the platform writes to carry its links ({@link offerScopeOf}),
 * closed by default, so a stranger's `connect_url` key never becomes one. A
 * spelling-based denylist could not be that safety net anyway: a stranger is
 * as free to call the field `url` or `href`.
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
  /** RFC 3339. */
  expiresAt?: string;
  /**
   * Integration the link connects (`@scope/name`). A run-kickoff 409 item
   * pairs it with `connect_url`; the card uses it for the integration's
   * icon and display name, and to claim the resume append.
   */
  packageId?: string;
}

interface SplitResult {
  /** Redacted value; the ORIGINAL reference when nothing changed (prompt-cache friendly). */
  value: unknown;
  changed: boolean;
}

/**
 * Where one walk pushes its offers, in walk order and undeduped — dedupe lives
 * in {@link mergeConnectOffers} alone. `null` inside a subtree whose links are
 * redacted but never offered.
 */
type OfferSink = ConnectOffer[] | null;

/** A subtree of a payload: object keys, `"*"` for every element of an array. */
type Path = readonly string[];

/**
 * The subtrees of a payload the platform did not write, which no connect card may come from
 * ({@link OfferScope}):
 *
 * - `verbatim` — relayed from a third party as is (an upstream API's body, a remote MCP server's
 *   schemas): passed on untouched, its keys the stranger's to name;
 * - `unoffered` — stored by the platform but written by someone else (an agent's output, a file):
 *   its links are redacted all the same, never offered.
 */
interface Untrusted {
  verbatim: readonly Path[];
  unoffered: readonly Path[];
}

const TRUSTED: Untrusted = { verbatim: [], unoffered: [] };

/** `untrusted` as seen from the child under `key`. */
function under(untrusted: Untrusted, key: string): Untrusted {
  if (untrusted.verbatim.length === 0 && untrusted.unoffered.length === 0) return untrusted;
  const step = (paths: readonly Path[]) =>
    paths.filter((path) => path[0] === key).map((path) => path.slice(1));
  return { verbatim: step(untrusted.verbatim), unoffered: step(untrusted.unoffered) };
}

const reached = (paths: readonly Path[]) => paths.some((path) => path.length === 0);

/**
 * Optional offer fields, read under their wire spelling only — same reason as
 * {@link CONNECT_URL_KEYS} (`expiresAt` / `packageId`: casing carve-out 4b).
 */
function pickOfferFields(obj: Record<string, unknown>): Omit<ConnectOffer, "connect_url"> {
  return {
    ...(typeof obj.state === "string" ? { state: obj.state } : {}),
    ...(typeof obj.expiresAt === "string" ? { expiresAt: obj.expiresAt } : {}),
    ...(typeof obj.packageId === "string" ? { packageId: obj.packageId } : {}),
  };
}

/**
 * Deep-walk `value`, replacing every `connect_url`/`auth_url` string with the
 * placeholder and capturing each absolute-URL offer into `sink`, except in the
 * `untrusted` subtrees. When nothing changed the original reference is returned
 * so callers can keep text byte-identical (prompt caching).
 */
function splitValue(
  value: unknown,
  depth: number,
  sink: OfferSink,
  untrusted: Untrusted,
): SplitResult {
  if (reached(untrusted.verbatim)) return { value, changed: false };
  if (reached(untrusted.unoffered)) {
    sink = null;
    untrusted = { verbatim: untrusted.verbatim, unoffered: [] };
  }
  if (depth > MAX_REDACT_DEPTH || value == null || typeof value !== "object") {
    return { value, changed: false };
  }

  if (Array.isArray(value)) {
    const items = under(untrusted, "*");
    let changed = false;
    const out = value.map((item) => {
      const r = splitValue(item, depth + 1, sink, items);
      if (r.changed) changed = true;
      return r.value;
    });
    return changed ? { value: out, changed: true } : { value, changed: false };
  }

  const obj = value as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) {
    const child = under(untrusted, key);
    if (CONNECT_URL_KEYS.has(key) && typeof v === "string" && !reached(child.verbatim)) {
      out[key] = REDACTED_CONNECT_LINK;
      changed = true;
      // Capture only parsed absolute HTTP(S) URLs — an already-redacted
      // placeholder, malformed value or other scheme is scrubbed but never
      // offered. Persist the same normalized href the browser will navigate.
      const connectUrl = normalizeHttpUrl(v);
      if (connectUrl && sink && !reached(child.unoffered)) {
        sink.push({ connect_url: connectUrl, ...pickOfferFields(obj) });
      }
      continue;
    }
    const r = splitValue(v, depth + 1, sink, child);
    if (r.changed) changed = true;
    out[key] = r.value;
  }
  return changed ? { value: out, changed: true } : { value, changed: false };
}

/**
 * A tool payload split into its redacted copy and the connect offers it carries. A connect card
 * is a platform-trusted surface: its link must come from a payload the platform wrote to carry
 * one, never from content it relays or stores ({@link offerScopeOf}).
 */
export type OfferScope = (payload: unknown) => { redacted: unknown; offers: ConnectOffer[] };

function scopeOf(untrusted: Untrusted): OfferScope {
  return (payload) => {
    const sink: ConnectOffer[] = [];
    const r = splitValue(payload, 0, sink, untrusted);
    return { redacted: r.value, offers: mergeConnectOffers([sink]) };
  };
}

/**
 * Split a payload the platform wrote whole: redacted copy + every offer it carried, in walk
 * order. `redacted` is the same reference when nothing changed.
 */
export const splitConnectPayload: OfferScope = scopeOf(TRUSTED);

/**
 * Split a text block that may hold a JSON payload under `scope` ({@link offerScopeOf}): parses,
 * redacts, and re-stringifies ONLY when something changed — non-JSON text passes through
 * byte-identical, never regex-mangled.
 */
export function splitJsonText(
  text: string,
  scope: OfferScope,
): { text: string; offers: ConnectOffer[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text, offers: [] };
  }
  const split = scope(parsed);
  return {
    text: split.redacted === parsed ? text : JSON.stringify(split.redacted),
    offers: split.offers,
  };
}

/** Relayed whole: passed on verbatim, no card. */
const RELAYED = scopeOf({ verbatim: [[]], unoffered: [] });

/** Not written to carry an offer: every link redacted, none offered. */
const UNOFFERED = scopeOf({ verbatim: [], unoffered: [[]] });

/**
 * The operations whose response IS one of the platform's connect links: the hosted connect
 * portal (`connect_url`) and the headless OAuth start (`auth_url`). `invoke_operation` sends no
 * `X-Appstrate-Connect-Offers`, so no other operation answers it with a link the platform minted
 * for the chat; what else might hold one (a run's result, its logs, a file) someone else wrote.
 */
const CONNECT_OPERATIONS: ReadonlySet<string> = new Set([
  "initiateIntegrationConnect",
  "initiateIntegrationOAuth",
]);

/**
 * The tools whose result the platform writes to carry its connect links, each with the subtrees
 * that are not its own. `run_and_wait`: its launch refusal (409 readiness items), never the run's
 * `result`, which the agent wrote. `search` and `describe`: the integration tools' `not_ready`
 * and `unlisted` refusals and their own refusals, never what a member wrote (an agent's or a
 * skill's description, input and output, an item list or `best_match` holding them), nor a
 * remote server's schemas, which stay verbatim. `call_integration_tool`: its refusals and an
 * `api_call` batch's per-request `error`, never the upstream's `body` and `headers` (a remote
 * server's own result comes marked relayed, see {@link offerScopeOf}).
 */
const OFFER_SOURCES: Readonly<Record<string, OfferScope>> = {
  run_and_wait: scopeOf({ verbatim: [], unoffered: [["result"]] }),
  search: scopeOf({
    verbatim: [["operations"], ["integration_tools", "items"]],
    unoffered: [["agents"], ["skills"], ["best_match"]],
  }),
  describe: scopeOf({
    verbatim: [["input_schema"], ["output_schema"]],
    unoffered: [
      ["input"],
      ["output"],
      ["dependencies"],
      ["frontmatter"],
      ["description"],
      ["display_name"],
      ["run_with"],
      ["resources"],
    ],
  }),
  call_integration_tool: scopeOf({
    verbatim: [
      ["results", "*", "body"],
      ["results", "*", "headers"],
    ],
    unoffered: [],
  }),
};

/**
 * The offer scope of one platform MCP tool call, by the tool's (unprefixed) name, its arguments
 * and whether its result came marked relayed (`_meta["dev.appstrate/relayed"]`, set by the
 * platform on a result a third party wrote whole). Closed by default: a tool not written to carry
 * a connect link offers none, and its links are redacted.
 */
export function offerScopeOf(
  toolName: string,
  call: { arguments?: unknown; relayed?: boolean },
): OfferScope {
  if (call.relayed) return RELAYED;
  if (toolName === "invoke_operation") {
    const operationId = (call.arguments as { operation_id?: unknown } | undefined)?.operation_id;
    return typeof operationId === "string" && CONNECT_OPERATIONS.has(operationId)
      ? splitConnectPayload
      : UNOFFERED;
  }
  return OFFER_SOURCES[toolName] ?? UNOFFERED;
}

/**
 * Concatenate offer lists in order, keeping the first entry per normalized
 * `connect_url`. The ONE dedupe rule: a single walk's offers pass through here
 * too ({@link scopeOf}), and `mcpResultToPi` uses it to merge across a
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
