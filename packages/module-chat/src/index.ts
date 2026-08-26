// SPDX-License-Identifier: Apache-2.0

/**
 * Chat module — first-party conversational UI over the platform.
 *
 * Scope of this module:
 *   - `chat_sessions` / `chat_messages` persistence (tables live in the core
 *     schema per the "modules own no tables" rule — this module only reads
 *     and writes them).
 *   - REST surface under `/api/chat/*`: session CRUD, history READ, resume and
 *     stop. Messages are written by `POST /api/chat` alone (server-authoritative
 *     persistence — see routes.ts); there is no message-append endpoint.
 *     Auto-exposed over MCP through the `mcp` module's `invoke_operation`
 *     once documented in the OpenAPI spec — no dedicated MCP tool needed.
 *   - Full-page React UI exported from `@appstrate/module-chat/ui`
 *     (`ChatPage`) — the app shell lazy-loads it behind `features.chat`.
 *
 * The conversational loop (`POST /api/chat`) is the transplant of the
 * appstrate-chat satellite: one in-process Pi engine over the org's configured
 * models (llm-proxy for API-key models, native provider call for OAuth
 * subscriptions — no long-lived key held here either way) + the `/api/mcp` meta-tools
 * so the assistant pilots the platform with the caller's own permissions.
 */

import type { AppstrateModule, ModuleInitContext } from "@appstrate/core/module";
import { createChatRouter, createSessionSchema, renameSessionSchema } from "./routes.ts";
import { chatPaths, chatComponentSchemas } from "./openapi.ts";
import { chatLoopbackStrategy } from "./loopback-auth.ts";
import { buildChatPlatformDeps, type ChatPlatformDeps } from "./platform-services.ts";
import { drainTurns } from "./inflight.ts";
import { reconcileChatRun } from "./run-reconcile.ts";
import { logger } from "./logger.ts";
import { warnIfDefaultChatConcurrency } from "./pi-chat/concurrency.ts";
import { loadPiCodingAgentSdk } from "@appstrate/runner-pi";
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
  // `mcp` is a HARD peer requirement: the chat's whole value is piloting the
  // platform through the MCP meta-tools. Declaring it here both orders boot
  // (mcp first) and — via the loader's declared-dependency presence check —
  // turns a missing `mcp` module into a fatal boot/config error rather than a
  // silently degraded no-tools chat.
  manifest: { id: "chat", name: "Chat", version: "0.1.0", dependencies: ["mcp"] },

  async init(ctx: ModuleInitContext) {
    // Tables are centralized in the core schema — nothing to migrate. No
    // workers: chat is request-driven. Capture the platform deps once: the
    // rate limiter, the in-process dispatcher (re-enters the platform app for
    // /api/models, /api/spaces, /api/me/context and the MCP hops —
    // loopback fetch fallback inside; inference does NOT ride it, pi-ai opens a
    // real socket to the llm-proxy at `CHAT_SELF_ORIGIN`), and the chat-model
    // resolution + usage metering.
    deps = buildChatPlatformDeps(ctx);
    // Chat now runs entirely in-process, so its concurrency cap is a capacity
    // decision an operator must make deliberately. Say so at boot.
    warnIfDefaultChatConcurrency();
    // Warm the Pi SDK's value graph. `loadPiCodingAgentSdk()` is a dynamic
    // import of the single most expensive module in the runtime graph (~200 ms
    // to evaluate, see `packages/runner-pi/src/pi-sdk.ts`), memoized by the ESM
    // registry after the first call. The container entrypoint already warms it
    // during its network-bound provisioning phase; nothing did on the API side,
    // so the first chat turn after every deploy paid it inline, on the
    // time-to-first-token path. Fire-and-forget: a failure here is not fatal
    // (the turn re-awaits the same import and surfaces the real error there),
    // so it is logged and swallowed rather than allowed to fail boot.
    void loadPiCodingAgentSdk().catch((err: unknown) => {
      logger.warn("pi sdk warm-up failed — the first chat turn will pay the import", {
        err: String(err),
      });
    });
  },

  createRouter() {
    // The module loader registers a module only after `init()` returns, so
    // `deps` is always populated by the time anything can call this — in
    // production AND under the test harness, which runs the same pipeline
    // since #989. An unset `deps` means a caller reached past the loader; fail
    // loudly rather than serve a degraded baseline that looks like it works.
    if (!deps) {
      throw new Error("chat module: createRouter() called before init() — no platform context");
    }
    return createChatRouter(deps);
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
        method: "PATCH",
        path: "/api/chat/sessions/{id}",
        jsonSchema: z.toJSONSchema(renameSessionSchema) as Record<string, unknown>,
        description: "Rename chat session",
      },
    ];
  },

  // A run launched from a chat turn can outlive it (the audited `report.html`
  // landed 2 minutes after its turn was killed). On every terminal transition,
  // check whether the launching session is idle and, if so, tell it what the run
  // produced — see `run-reconcile.ts` for the liveness rule and its trade-offs.
  // Event errors are isolated by the loader; the catch is only here so a failure
  // leaves a trace instead of vanishing.
  events: {
    onRunStatusChange: async (params) => {
      if (params.status === "started") return;
      try {
        await reconcileChatRun({ runId: params.runId, orgId: params.orgId });
      } catch (err) {
        logger.warn("chat: orphaned-run reconciliation failed", {
          runId: params.runId,
          err: String(err),
        });
      }
    },
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

  // Graceful shutdown: await in-flight turns so a deploy/restart does not drop a
  // reply that was mid-generation (bounded — a wedged turn cannot block exit).
  async shutdown() {
    const drained = await drainTurns();
    if (drained > 0) logger.info("chat: drained in-flight turns on shutdown", { count: drained });
  },
};

export default chatModule;
