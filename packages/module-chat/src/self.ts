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

/** Loopback origin of the running platform (same process, no proxy hop). */
export function selfOrigin(): string {
  const port = process.env.PORT ?? "3000";
  return process.env.CHAT_SELF_ORIGIN ?? `http://127.0.0.1:${port}`;
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
