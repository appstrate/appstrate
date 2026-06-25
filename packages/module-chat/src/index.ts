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
 *   - Full-page React UI exported from `@appstrate/module-chat/ui`
 *     (`ChatPage`) — the app shell lazy-loads it behind `features.chat`.
 *
 * The conversational loop (`POST /api/chat`) is the transplant of the
 * appstrate-chat satellite: AI SDK `streamText` over the org's configured
 * models (via the llm-proxy — no key held here) + the `/api/mcp` meta-tools
 * so the assistant pilots the platform with the caller's own permissions.
 */

import type { AppstrateModule, ModuleInitContext } from "@appstrate/core/module";
import {
  createChatRouter,
  createSessionSchema,
  renameSessionSchema,
  messageEntrySchema,
} from "./routes.ts";
import { chatPaths, chatComponentSchemas } from "./openapi.ts";
import { chatLoopbackStrategy } from "./loopback-auth.ts";
import { buildChatPlatformDeps, type ChatPlatformDeps } from "./platform-services.ts";
import { z } from "zod";

// Platform deps captured at init from `ctx.services` (immutable; no module-level
// mutable service setters). `createRouter()` runs after `init()` in the module
// lifecycle, so this is always populated by the time the router is built.
let deps: ChatPlatformDeps | null = null;

declare module "@appstrate/core/permissions" {
  interface ModuleResources {
    chat: "read" | "write";
  }
}

const chatModule: AppstrateModule = {
  manifest: { id: "chat", name: "Chat", version: "0.1.0" },

  async init(ctx: ModuleInitContext) {
    // Tables are centralized in the core schema — nothing to migrate. No
    // workers: chat is request-driven. Capture the platform deps once: the
    // rate limiter, the in-process dispatcher (re-enters the platform app for
    // /api/models, /api/applications, /api/me/context, the llm-proxy — loopback
    // fetch fallback inside), and the subscription chat-engine lookup.
    deps = buildChatPlatformDeps(ctx);
  },

  createRouter() {
    // Production runs `init()` before `createRouter()`, so `deps` is populated.
    // When a caller mounts the router without init (the apps/api test harness,
    // OSS standalone wiring), fall back to the safe baseline deps (loopback
    // dispatch, pass-through rate limiter, no chat engine).
    return createChatRouter(deps ?? buildChatPlatformDeps());
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
