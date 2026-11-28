// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import type { AppstrateMcpClient } from "@appstrate/mcp-transport";
import { mintMcpLoopbackToken } from "./loopback-auth.ts";
import { connectPlatformMcp } from "./pi-chat/mcp-tools.ts";
import type { ChatEnv } from "./prompt.ts";
import { selfOrigin } from "./self.ts";
import type { ChatPlatformDeps } from "./platform-services.ts";

/**
 * Where the chat's own MCP client points.
 *
 * The platform exposes its REST surface through progressive MCP tools
 * (`search` / `describe` / `invoke_operation`) plus the
 * run-specific `run_and_wait` shortcut, so the model can drive Appstrate with
 * the caller's own permissions. The chat engine opens that connection itself
 * (`pi-chat/mcp-tools.ts`); this module only owns the URL both sides must agree
 * on.
 */

/**
 * URL of the organization's MCP endpoint (`/api/mcp/o/:org`, where every space-acting tool
 * names its `space_id`; the turn's bearer allowlists the spaces it may name — a limited
 * conversation's origin alone), tagged `?renders_cards=true`.
 *
 * The tag tells the server this client renders connect offers and run cards itself and resumes an
 * unfinished run on a later turn, so its instructions say so; the tools are the same as any
 * client's.
 */
export function platformMcpUrl(origin: string, orgId: string): string {
  return `${origin}/api/mcp/o/${encodeURIComponent(orgId)}?renders_cards=true`;
}

/**
 * The platform-call seam as a `fetch`: every hop re-enters the platform app in-process, auth and
 * RBAC running on each.
 */
export function dispatchFetch(deps: Pick<ChatPlatformDeps, "dispatch">): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    deps.dispatch(new Request(input, init))) as typeof fetch;
}

/** The role the caller acts with: the persona's while a preview is on, else the real one. */
export function actingOrgRole(c: Context<ChatEnv>): string {
  return c.get("viewAs")?.orgRole ?? c.get("orgRole") ?? "member";
}

/**
 * Deadline of a read over the caller's own MCP connection (the turn's skills, the composer's
 * commands, an agent launch's prompt), connection included: the preamble runs before the turn's
 * abort controller exists, and a client disconnect never cancels a turn, so the read carries its
 * own bound. Past it the pending reads fail on the signal: a turn goes on with what it could not
 * read left out, an agent launch is refused.
 */
const CALLER_READ_TIMEOUT_MS = 10_000;

/**
 * `use` over a caller connection opened by `openCaller` under {@link CALLER_READ_TIMEOUT_MS},
 * always closed after. A failed connect rethrows, or answers `unreachable(err)` when given.
 */
export async function withCallerClient<C extends { close(): Promise<unknown> }, T>(
  openCaller: (signal: AbortSignal) => Promise<C>,
  use: (client: C, signal: AbortSignal) => Promise<T>,
  unreachable?: (err: unknown) => T,
): Promise<T> {
  const signal = AbortSignal.timeout(CALLER_READ_TIMEOUT_MS);
  let client: C;
  try {
    client = await openCaller(signal);
  } catch (err) {
    if (!unreachable) throw err;
    return unreachable(err);
  }
  try {
    return await use(client, signal);
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * A connection of the CALLER to the platform MCP server, opened on demand: the bearer carries the
 * caller's own `permissions` over `spaces` and no claim of a turn (no injected skills, no
 * session), so it reads what the caller reads. Used for what is read before a turn's own claim
 * exists (the turn's skills, an agent launch's prompt) and by the composer's commands; the caller
 * closes it. `signal` cancels the connect. `fetch` is the in-process platform seam.
 */
export function callerMcpOpener(
  c: Context<ChatEnv>,
  fetch: typeof globalThis.fetch,
  scope: {
    permissions: Iterable<string>;
    spaces: readonly { id: string }[];
    restricted: boolean;
  },
): (signal: AbortSignal) => Promise<AppstrateMcpClient> {
  const user = c.get("user");
  const orgId = c.get("orgId");
  return (signal) =>
    connectPlatformMcp({
      signal,
      url: platformMcpUrl(selfOrigin(), orgId),
      headers: {
        Authorization: `Bearer ${mintMcpLoopbackToken({
          userId: user.id,
          email: user.email,
          name: user.name,
          orgId,
          orgRole: actingOrgRole(c),
          permissions: [...scope.permissions],
          viewAs: c.get("viewAs"),
          spaceIds: scope.spaces.map((space) => space.id),
          restricted: scope.restricted,
        })}`,
        "x-org-id": orgId,
      },
      fetch,
    });
}
