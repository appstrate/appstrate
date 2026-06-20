// SPDX-License-Identifier: Apache-2.0

/**
 * In-process identity forwarding.
 *
 * The chat module consumes the platform through its own public surfaces
 * (`/api/models`, `/api/applications`, `/api/llm-proxy`, `/api/mcp`) instead
 * of importing apps/api internals — the same defence-in-depth the `mcp`
 * module applies: the chat can never do more than the caller's credential
 * could over REST.
 *
 * Where the satellite chat carried two audience-bound OAuth tokens, the
 * module simply forwards the caller's own credentials (session cookie or
 * Authorization header + org/app scoping headers) on a loopback request.
 * The platform auth pipeline re-authenticates each hop.
 */

import type { Context } from "hono";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Loopback origin of the running platform (same process, no proxy hop).
 *
 * `forwardedHeaders` sends the caller's cookie / Authorization on this hop, so
 * the target MUST stay on-host: a `CHAT_SELF_ORIGIN` pointing at an external
 * host would exfiltrate the caller's credentials. We therefore reject any
 * override that is not a loopback origin (fail-fast rather than leak).
 */
export function selfOrigin(): string {
  const override = process.env.CHAT_SELF_ORIGIN;
  if (override) {
    let host: string;
    try {
      host = new URL(override).hostname;
    } catch {
      throw new Error(`CHAT_SELF_ORIGIN is not a valid URL: ${override}`);
    }
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error(
        `CHAT_SELF_ORIGIN must be a loopback origin (got "${host}"). The chat module ` +
          "forwards the caller's cookie/Authorization on this hop and must never send them off-host.",
      );
    }
    return override;
  }
  const port = process.env.PORT ?? "3000";
  return `http://127.0.0.1:${port}`;
}

const FORWARDED = ["cookie", "authorization", "x-org-id", "x-application-id"] as const;

/** Copy the caller's auth + scoping headers onto an outgoing loopback call. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function forwardedHeaders(c: Context<any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FORWARDED) {
    const value = c.req.header(name);
    if (value) out[name] = value;
  }
  return out;
}
