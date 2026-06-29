// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helper (no React) that pulls a connect offer (`{ connect_url }` for the
 * unified hosted-connect-portal op, or the legacy `{ auth_url, state }` OAuth
 * op) out of an `invoke_operation` tool result. The result arrives in many envelopes
 * depending on the runtime path (raw MCP CallToolResult `{content:[{text}]}`,
 * the AI SDK bridge `{type:"content",value:[{text}]}`, `{type:"json",value}`,
 * a bare content array, a JSON string, …), so rather than enumerate shapes we
 * walk the whole structure and grab the first node that carries an auth URL.
 *
 * Kept React-free so it can be unit-tested without a DOM.
 */

export interface AuthOffer {
  authUrl: string;
  state?: string;
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

/** Find an `{ auth_url|authUrl }` bearing object anywhere in `value`. */
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
  const url = obj.connect_url ?? obj.connectUrl ?? obj.auth_url ?? obj.authUrl;
  if (typeof url === "string" && url) {
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
  return deepFind(result, 0);
}
