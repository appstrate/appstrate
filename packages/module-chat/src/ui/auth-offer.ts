// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helper (no React) that pulls the connect offer out of an
 * `invoke_operation` tool result.
 *
 * Single channel: the typed `connectOffer` field the engine attaches to the
 * tool output ({@link ../connect-offer.ts}) — the only place the live URL
 * exists in a persisted result. The payload itself is never scraped; in the
 * model channel every connect URL is replaced by the redaction placeholder, and
 * scraping it rendered that placeholder as a relative href (issue #906).
 *
 * Kept React-free so it can be unit-tested without a DOM.
 */

import type { IntegrationConnectCompletion } from "@appstrate/core/connect-handshake";
import { readConnectOffer } from "../connect-offer.ts";

interface AuthOffer {
  authUrl: string;
  state?: string;
}

/** Payload the connect surfaces broadcast — defined in `@appstrate/core`. */
export type CompletionDetail = IntegrationConnectCompletion;

/**
 * The completion CORRELATION rule — which waiting surface a given completion is
 * addressed to, and the origin check in front of it on the `postMessage`
 * carrier — is `@appstrate/core/connect-handshake`, not this file. Re-exported
 * here because the cards import it from here.
 *
 * It used to be declared here, and that was the half of the handshake left
 * behind when the rest was centralised: living in this module put it out of
 * reach of the SPA's connect popup, which re-implemented the gate as "is it a
 * completion and is `ok` true" — no state, no packageId, with the packageId it
 * was waiting on three lines up. A rule only one of four surfaces can import is
 * not a single source of truth.
 */
export { acceptsCompletionMessage, completionMatches } from "@appstrate/core/connect-handshake";

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

export function extractAuthOffer(result: unknown): AuthOffer | null {
  const offer = readConnectOffer(result);
  if (!offer) return null;
  return { authUrl: offer.connect_url, ...(offer.state ? { state: offer.state } : {}) };
}
