// SPDX-License-Identifier: Apache-2.0

/**
 * In-process identity forwarding.
 *
 * The chat module consumes the platform through its own public surfaces
 * (`/api/models`, `/api/spaces`, `/api/llm-proxy`, `/api/mcp`) instead
 * of importing apps/api internals — the same defence-in-depth the `mcp`
 * module applies: the chat can never do more than the caller's credential
 * could over REST.
 *
 * Where the satellite chat carried two audience-bound OAuth tokens, the
 * module simply forwards the caller's own credentials (session cookie or
 * Authorization header + org/space scoping headers) on a loopback request.
 * The platform auth pipeline re-authenticates each hop.
 */

import type { Context } from "hono";
import { VIEW_AS_HEADER } from "@appstrate/core/permissions";
import { getChatEnv } from "./env.ts";

/** Loopback origin of the running platform — see {@link getChatEnv}. */
export function selfOrigin(): string {
  return getChatEnv().selfOrigin;
}

/**
 * `x-view-as` rides with the scoping headers: a loopback read made under a role
 * preview must answer as that role, or the prompt describes an org the previewed
 * role cannot reach. The platform re-validates it on the hop.
 */
const FORWARDED = [
  "cookie",
  "authorization",
  "x-org-id",
  "x-space-id",
  VIEW_AS_HEADER.toLowerCase(),
] as const;

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
