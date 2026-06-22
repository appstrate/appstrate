// SPDX-License-Identifier: Apache-2.0

/**
 * Chat module — first-party conversational UI over the platform.
 *
 * Scope of this module:
 *   - `chat_sessions` / `chat_messages` persistence (tables live in the core
 *     schema per the "modules own no tables" rule — this module only reads
 *     and writes them).
 *   - REST surface under `/api/chat/*` (sessions CRUD + message append).
 *     Auto-exposed over MCP through the `mcp` module's `invoke_operation`
 *     once documented in the OpenAPI spec — no dedicated MCP tool needed.
 *   - Embeddable React UI exported from `@appstrate/module-chat/ui`
 *     (`ChatPanel` component-first; `ChatPage` is a thin wrapper). Other
 *     modules (e.g. documents/workspace) import `ChatPanel` directly to
 *     embed the chat next to their own UI.
 *
 * The conversational loop (`POST /api/chat`) is the transplant of the
 * appstrate-chat satellite: AI SDK `streamText` over the org's configured
 * models (via the llm-proxy — no key held here) + the `/api/mcp` meta-tools
 * so the assistant pilots the platform with the caller's own permissions.
 */

import { tmpdir } from "node:os";
import type { AppstrateModule, ModuleInitContext } from "@appstrate/core/module";
import { sweepStaleCodexHomes } from "@appstrate/core/codex-binary";
import {
  createChatRouter,
  createSessionSchema,
  renameSessionSchema,
  messageEntrySchema,
  setRateLimitFactory,
} from "./routes.ts";
import { chatPaths, chatComponentSchemas } from "./openapi.ts";
import { chatLoopbackStrategy } from "./loopback-auth.ts";
import { CODEX_CHAT_HOME_PREFIX, codexChatHomeBase } from "./codex-agent/engine.ts";
import { logger } from "./logger.ts";
import { z } from "zod";

/** Max age of a codex chat token home before the boot sweep reclaims it. */
const STALE_CODEX_HOME_MS = 60 * 60 * 1000;

declare module "@appstrate/core/permissions" {
  interface ModuleResources {
    chat: "read" | "write";
  }
}

const chatModule: AppstrateModule = {
  manifest: { id: "chat", name: "Chat", version: "0.1.0" },

  async init(ctx: ModuleInitContext) {
    // Tables are centralized in the core schema — nothing to migrate.
    // No workers: chat is request-driven. Wire the platform rate limiter
    // into the router (POST /api/chat fans out into metered LLM traffic).
    setRateLimitFactory((maxPerMinute) => ctx.services.http.rateLimit(maxPerMinute));

    // Reclaim any codex chat token homes leaked by an ungraceful kill on a
    // prior boot (SIGKILL/OOM between writeCodexAuthHome and its finally). Sweep
    // both the RAM-backed base (when present) and the OS temp fallback.
    const bases = new Set([tmpdir(), codexChatHomeBase()].filter((b): b is string => Boolean(b)));
    for (const baseDir of bases) {
      const removed = await sweepStaleCodexHomes({
        baseDir,
        prefix: CODEX_CHAT_HOME_PREFIX,
        maxAgeMs: STALE_CODEX_HOME_MS,
        nowMs: Date.now(),
      }).catch(() => 0);
      if (removed > 0) logger.warn("chat: swept stale codex token homes", { baseDir, removed });
    }
  },

  createRouter() {
    return createChatRouter();
  },

  // Loopback bearer for the module's own inference calls — the proxy
  // surfaces are bearer-only (cookies refused), and this strategy is the
  // only producer/consumer of its token shape (see loopback-auth.ts).
  authStrategies() {
    return [chatLoopbackStrategy];
  },

  openApiPaths() {
    return chatPaths;
  },

  openApiComponentSchemas() {
    return chatComponentSchemas;
  },

  openApiTags() {
    return [{ name: "Chat", description: "Chat sessions and messages" }];
  },

  openApiSchemas() {
    return [
      {
        method: "POST",
        path: "/api/chat/sessions",
        jsonSchema: z.toJSONSchema(createSessionSchema) as Record<string, unknown>,
        description: "Create chat session",
      },
      {
        method: "POST",
        path: "/api/chat/sessions/{id}/messages",
        jsonSchema: z.toJSONSchema(messageEntrySchema) as Record<string, unknown>,
        description: "Append chat history entry",
      },
      {
        method: "PATCH",
        path: "/api/chat/sessions/{id}",
        jsonSchema: z.toJSONSchema(renameSessionSchema) as Record<string, unknown>,
        description: "Rename chat session",
      },
    ];
  },

  features: { chat: true },

  // Chat sessions are personal (scoped org + user) — every org member can
  // read/write their own. Not API-key-grantable for now (the dashboard and
  // embedded panels authenticate with the user session); end-user chat via
  // OIDC tokens is a follow-up (flip `endUserGrantable` when the embedded
  // B2B2C chat ships).
  permissionsContribution: () => [
    {
      resource: "chat",
      actions: ["read", "write"],
      grantTo: ["owner", "admin", "member"],
    },
  ],
};

export default chatModule;
