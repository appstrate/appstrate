// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helper (no React) that pulls a connect offer (`{ connect_url }` for the
 * unified hosted-connect-portal op, or the legacy `{ auth_url, state }` OAuth
 * op) out of an `invoke_operation` tool result.
 *
 * Primary channel: the typed `connectOffer` field both engines attach to the
 * tool output ({@link ../connect-offer.ts}) — the only place the live URL
 * exists in a persisted result. The deep-walk below is a LEGACY fallback for
 * sessions persisted before that field shipped, where the URL still sits raw
 * somewhere in the payload (raw MCP CallToolResult `{content:[{text}]}`, the
 * AI SDK bridge `{type:"content",value:[{text}]}`, `{type:"json",value}`, a
 * bare content array, a JSON string, …).
 *
 * Kept React-free so it can be unit-tested without a DOM.
 */

import { readConnectOffer } from "../connect-offer.ts";

export interface AuthOffer {
  authUrl: string;
  state?: string;
}

/** Payload the OAuth callback page broadcasts (see `apps/api/src/lib/oauth-popup-html.ts`). */
export interface CompletionDetail {
  type?: string;
  ok?: boolean;
  state?: string;
  packageId?: string;
  error?: string;
}

/**
 * Whether a completion broadcast is addressed to the card identified by
 * `{ state, packageId }`. BroadcastChannel/postMessage signals fan out to every
 * mounted card, so correlation lives here:
 *
 *  - `state` — exact when both sides carry one. The hosted-connect offer
 *    (`connect_url`) carries NO state (its OAuth state is minted later, at
 *    /connect/start click time), so cards from that flow can't rely on it.
 *  - `packageId` — the package-level filter, mirroring the SSE
 *    `connection_update` backstop so all three completion signals share the
 *    same semantics. Without it, one Gmail connect flipped an unrelated card
 *    "connected" and double-resumed the conversation (forked thread).
 *
 * Completions without a packageId (context-less error pages such as "Missing
 * connect token") stay accepted: they only surface an error, never an append.
 */
export function completionMatches(
  detail: CompletionDetail | undefined,
  card: { messageType: string; state?: string; packageId?: string },
): boolean {
  if (!detail || detail.type !== card.messageType) return false;
  if (card.state && detail.state && detail.state !== card.state) return false;
  if (card.packageId && detail.packageId && detail.packageId !== card.packageId) return false;
  return true;
}

/**
 * One resume append per (package, completion) across every card in this tab.
 *
 * A single completion signal reaches ALL mounted cards, so two cards awaiting
 * the same package — e.g. a retry card issued after an abandoned first
 * attempt — would BOTH append a resume message, forking the conversation into
 * two concurrent turns (each user turn chains onto the last message, but each
 * assistant turn chains onto its own trigger). The first card to complete
 * claims the append; siblings settle for the connected visual. The short TTL
 * only needs to outlive the fan-out burst (all cards fire within ms of one
 * broadcast) while staying well under any legitimate later reconnect in the
 * same conversation.
 */
const RESUME_CLAIM_TTL_MS = 30_000;
const resumeClaims = new Map<string, number>();

export function claimResume(packageId: string | undefined, now = Date.now()): boolean {
  if (!packageId) return true;
  const prev = resumeClaims.get(packageId);
  if (prev !== undefined && now - prev < RESUME_CLAIM_TTL_MS) return false;
  resumeClaims.set(packageId, now);
  return true;
}

/**
 * Prefix the chat auto-resume message carries so the UI can render it as a
 * discreet "connected" notice instead of a raw user bubble. It is an invisible
 * separator (U+2063) so the model still reads the instruction and nothing shows
 * even if a surface fails to special-case it. Persisted with the message, so
 * the swap survives a reload. Shared with `oauth-connect-card` (writer) and
 * `thread`'s UserMessage (reader).
 */
export const INTEGRATION_RESUME_MARKER = "⁣appstrate:integration-connected⁣";

/** Invisible (U+2063) separator between the encoded meta and the human text. */
const RESUME_FIELD_SEP = "⁣";

/** Integration identity the resume chip renders (icon + display name). */
export interface ResumeMeta {
  packageId: string;
  name?: string;
  /** Iconify id (e.g. `logos:google-gmail`) or an image URL. */
  icon?: string;
}

/**
 * Build the auto-resume message text: `MARKER + JSON(meta) + SEP + human`. The
 * model reads the human instruction; the UI strips the marker, parses the meta,
 * and renders the connected chip. Meta rides in the (persisted) text so the
 * chip survives a reload without a refetch.
 */
export function encodeResume(meta: ResumeMeta, human: string): string {
  return `${INTEGRATION_RESUME_MARKER}${JSON.stringify(meta)}${RESUME_FIELD_SEP}${human}`;
}

/** Decode a resume message; null when `text` isn't one. */
export function parseResume(text: string): ResumeMeta | null {
  if (!text.startsWith(INTEGRATION_RESUME_MARKER)) return null;
  const rest = text.slice(INTEGRATION_RESUME_MARKER.length);
  const json = rest.split(RESUME_FIELD_SEP, 1)[0] ?? "";
  try {
    const meta = JSON.parse(json) as ResumeMeta;
    if (meta && typeof meta.packageId === "string") return meta;
  } catch {
    // Older resume messages had no meta payload — treat as a bare notice.
  }
  return { packageId: "" };
}

/**
 * LEGACY deep search — pre-`connectOffer` sessions only. Finds an
 * `{ auth_url|authUrl|connect_url|connectUrl }` bearing object anywhere in
 * `value`.
 */
function deepFind(value: unknown, depth: number): AuthOffer | null {
  if (depth > 8 || value == null) return null;

  // JSON encoded as a string (MCP text parts carry the body this way).
  if (typeof value === "string") {
    const s = value.trim();
    if (s[0] !== "{" && s[0] !== "[") return null;
    try {
      return deepFind(JSON.parse(s), depth + 1);
    } catch {
      return null;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = deepFind(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  if (typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;

  // Direct hit on this node (snake or camel). `connect_url` is the unified
  // hosted-connect-portal offer (issue #769); `auth_url` is the legacy
  // OAuth-only offer. Both open the same way and resume via the same signal.
  // Absolute-URL guard: pre-`connectOffer` results carry the redaction
  // placeholder under these same keys in the model channel — accepting it
  // rendered the placeholder as a relative href (issue #906).
  const url = obj.connect_url ?? obj.connectUrl ?? obj.auth_url ?? obj.authUrl;
  if (typeof url === "string" && /^https?:\/\//.test(url)) {
    const state = obj.state;
    return { authUrl: url, state: typeof state === "string" ? state : undefined };
  }

  // Otherwise descend into every child value.
  for (const child of Object.values(obj)) {
    const hit = deepFind(child, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export function extractAuthOffer(result: unknown): AuthOffer | null {
  // Typed channel first — the only place a post-split result carries the URL.
  const offer = readConnectOffer(result);
  if (offer) return { authUrl: offer.connect_url, ...(offer.state ? { state: offer.state } : {}) };
  // Legacy sessions persisted before the typed field existed.
  return deepFind(result, 0);
}
