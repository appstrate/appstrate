// SPDX-License-Identifier: Apache-2.0

/**
 * Keyed completely: the server derives `instructions` and `tools/list` from `permissions`,
 * `ceiling`, `actor.type`, `contextInjected` and the boot-time catalog alone, which for
 * the chat's bearer reduce to the minted list and the URL's `context` (enforced by
 * `pi-chat-mcp-surface-key.test.ts`). The TTL evicts a narrower surface a mid-handshake
 * role change stored under the wider key; tool calls are authorized live regardless.
 */

import type { AppstrateMcpClient } from "@appstrate/mcp-transport";

export interface PlatformMcpSurface {
  instructions?: string;
  tools: Awaited<ReturnType<AppstrateMcpClient["listTools"]>>["tools"];
}

export const MCP_SURFACE_CACHE_MAX_ENTRIES = 64;

/** `permissions` MUST be the list minted into the bearer. The org path segment reaches no descriptor. */
export function platformMcpSurfaceKey(url: string, permissions: readonly string[]): string {
  const parsed = new URL(url);
  return JSON.stringify([
    parsed.origin,
    parsed.searchParams.get("context"),
    [...new Set(permissions)].sort(),
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
