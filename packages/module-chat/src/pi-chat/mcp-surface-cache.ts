// SPDX-License-Identifier: Apache-2.0

/**
 * Keyed completely: the server derives `instructions` and `tools/list` from `permissions`,
 * `ceiling`, `actor.type`, `contextInjected`, the boot-time catalog and, on the organization
 * endpoint, the caller's reachable spaces (every space-acting tool lists them in its `space_id`, and a space's
 * `credentialProxyOpen` decides which tools it declares), which for the chat's bearer reduce to
 * the minted list, the URL's `context` and pin, and those spaces (enforced by `pi-chat-mcp-surface-key.test.ts`). The TTL evicts a
 * narrower surface a mid-handshake role change stored under the wider key; tool calls are
 * authorized live regardless.
 */

import type { ReachableSpaceGrant } from "@appstrate/core/module";
import type { AppstrateMcpClient } from "@appstrate/mcp-transport";

export interface PlatformMcpSurface {
  instructions?: string;
  tools: Awaited<ReturnType<AppstrateMcpClient["listTools"]>>["tools"];
}

export const MCP_SURFACE_CACHE_MAX_ENTRIES = 64;

/**
 * `permissions` MUST be the list minted into the bearer. The org and space ids of the path
 * reach no descriptor; whether it names a space does, and on the organization endpoint
 * `spaces` (the caller's reach: ids, names, roles, sets and direct-access
 * switches) are written into every one.
 */
export function platformMcpSurfaceKey(
  url: string,
  permissions: readonly string[],
  spaces: readonly ReachableSpaceGrant[],
): string {
  const parsed = new URL(url);
  return JSON.stringify([
    parsed.origin,
    parsed.searchParams.get("context"),
    /\/s\/[^/]+$/.test(parsed.pathname),
    [...new Set(permissions)].sort(),
    spaces
      .map((space) => [
        space.id,
        space.name,
        space.role,
        [...space.permissions].sort(),
        space.credentialProxyOpen,
      ])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  ]);
}

export const MCP_SURFACE_CACHE_TTL_MS = 5 * 60_000;

export class McpSurfaceCache {
  readonly #entries = new Map<string, { surface: PlatformMcpSurface; expiresAt: number }>();
  readonly #now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.#now = opts.now ?? Date.now;
  }

  get(key: string): PlatformMcpSurface | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    if (entry.expiresAt <= this.#now()) return undefined;
    this.#entries.set(key, entry);
    return structuredClone(entry.surface);
  }

  set(key: string, surface: PlatformMcpSurface): void {
    this.#entries.delete(key);
    this.#entries.set(key, {
      surface: structuredClone(surface),
      expiresAt: this.#now() + MCP_SURFACE_CACHE_TTL_MS,
    });
    if (this.#entries.size > MCP_SURFACE_CACHE_MAX_ENTRIES) {
      this.#entries.delete(this.#entries.keys().next().value!);
    }
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }
}

export const platformMcpSurfaceCache = new McpSurfaceCache();
