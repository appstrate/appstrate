// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /api/chat` — the conversational loop, ported from the appstrate-chat
 * satellite (routes/chat.ts) with two changes:
 *
 *   1. Identity: the satellite carried two audience-bound OAuth tokens; the
 *      module forwards the caller's own headers on loopback calls (self.ts).
 *   2. Persistence: owned by assistant-ui's NATIVE history adapter on the
 *      client (it POSTs each tree node to /api/chat/sessions/:id/messages)
 *      — this route only streams, exactly like the satellite.
 *
 * Inference goes through the llm-proxy (no key here); tool calls dispatch
 * through `/api/mcp` (auth + RBAC re-applied in-process).
 */

import type { Context } from "hono";
import { streamText, convertToModelMessages, stepCountIs, type UIMessage } from "ai";
import { z } from "zod";
import { parseBody, invalidRequest } from "@appstrate/core/api-errors";
import { logger } from "./logger.ts";
import { listModels, pickModel, modelFromFamily, resolveDefaultApplicationId } from "./llm.ts";
import { openPlatformMcp, platformMcpUrl } from "./platform-mcp.ts";
import { selfOrigin, forwardedHeaders } from "./self.ts";
import { mintLoopbackToken } from "./loopback-auth.ts";
import { subscriptionEngineDef } from "@appstrate/core/subscription-engines";
import { buildTranscriptPrompt } from "./transcript.ts";
import { getIntegrationsService } from "./platform-services.ts";

const MAX_STEPS = 16;

// Heading that fences the generated operation index at the tail of the platform
// MCP server instructions (emitted by apps/api/src/modules/mcp/router.ts). We
// split on this exact literal to drop the index — several KB re-sent on every
// step — for providers without a prompt cache, where it would be re-sent
// uncached every step: Mistral. Cached providers (Claude SDK, Anthropic via
// cache_control, OpenAI auto-prefix) keep it. If this literal drifts from the
// server's, the index simply stays — degraded cost, never a failure.
const OPERATION_INDEX_HEADING = "## Operation index";

/**
 * Strip the trailing operation index from the system prompt for providers
 * without a prompt cache, where the multi-KB index would be re-sent uncached on
 * every step: Mistral. Everyone else keeps it. Tools are unaffected — the agent
 * always has search_operations for discovery when the index is absent.
 */
export function applyOperationIndexPolicy(system: string, apiShape: string): string {
  const drop = apiShape === "mistral-conversations";
  if (drop && system.includes(OPERATION_INDEX_HEADING)) {
    return system.slice(0, system.indexOf(OPERATION_INDEX_HEADING)).trimEnd();
  }
  return system;
}

/**
 * TTL for the engine path's loopback bearer. The Agent SDK bakes it into the
 * spawned binary's env once, so it must outlive the whole turn (up to
 * MAX_STEPS turns, each able to long-poll a run's status for ~55 s). 30 min
 * is a generous ceiling for a single interactive turn.
 */
const ENGINE_LOOPBACK_TTL_MS = 30 * 60_000;

const SYSTEM_PROMPT = `You are Appstrate's assistant. You help the user operate their Appstrate instance — discovering and running agents, inspecting runs, scheduling, searching their documents — through the available tools.

Use the tools to ground every action: search for the right operation, read its schema, then invoke it. Never invent an operationId or argument shape. Runs are asynchronous — after triggering one, call the run-get operation with \`query: { wait: true }\` to long-poll the platform until the run is terminal (it returns after ~55s; if still running, call it again); never busy-poll in a tight loop yourself. Cite what the tools return; do not fabricate results.

When a tool call fails with a recoverable error (e.g. a validation error naming a missing or malformed field, or a wrong-endpoint 404), do not stop and report it. Read the error detail, correct the input — re-read the operation schema if needed — and retry, up to a few attempts. Only surface the failure to the user once you have genuinely exhausted reasonable fixes; then show the exact error.

Respect the user's role: actions beyond it will be refused by the platform — don't attempt them. When building or configuring an agent, prefer integrations the user already has connected (listed in their context below) over asking them to connect new ones.`;

// Fallback when the platform MCP module isn't reachable (e.g. `mcp` absent
// from MODULES). The chat keeps working for plain conversation — it just has
// no instance tools — so the prompt drops the tool-grounding instructions and
// tells the model to be upfront about the limitation.
const NO_TOOLS_SYSTEM_PROMPT = `You are Appstrate's assistant. Right now your instance tools are unavailable because the platform MCP module is not active, so you cannot search operations, run agents, inspect runs, or schedule. Answer the user's questions directly and conversationally. If the user asks for an action that needs those tools, say plainly that tools are disabled until the \`mcp\` module is enabled, rather than pretending to act.`;

// The subscription (claude-code) path doesn't probe the platform MCP for
// reachability (the SDK opens its own connection) — so unlike the ai-sdk path it
// can't pre-select NO_TOOLS_SYSTEM_PROMPT when the `mcp` module is absent. This
// note makes the tool-grounding prompt degrade gracefully in that rare config
// (claude-code enabled, mcp disabled): the model reports tools are off instead
// of looping on failing tool calls. Harmless when tools ARE present.
const SUBSCRIPTION_TOOLS_NOTE = `If your tool calls fail because the platform tools are unavailable (the \`mcp\` module is disabled on this instance), do not retry — tell the user plainly that instance tools are off and answer conversationally instead.`;

/** Shape of GET /api/me/context (the `get_me` payload). Validated loosely. */
interface CallerContext {
  user?: { name?: string | null; email?: string | null } | null;
  org?: { role?: string | null } | null;
  connections?: { integration_id: string; name: string; source: string }[] | null;
}

/**
 * Render the caller context into a system-prompt block. Returns "" when the
 * payload is unusable so the caller can skip injection.
 */
export function formatCallerContext(raw: unknown): string {
  const ctx = (raw ?? {}) as CallerContext;
  const name = ctx.user?.name?.trim();
  const email = ctx.user?.email?.trim();
  const role = ctx.org?.role?.trim();
  if (!name && !email && !role && !ctx.connections?.length) return "";

  const who = name && email ? `${name} (${email})` : (name ?? email ?? "the user");
  const lines = [
    "## Your context",
    `You are assisting ${who}${role ? `, whose role in this organization is "${role}"` : ""}.`,
  ];
  if (ctx.connections?.length) {
    const list = ctx.connections.map((c) => `${c.name} (${c.source})`).join(", ");
    lines.push(
      `Integrations the user has connected and could attach to an agent: ${list}. Prefer these when building or configuring an agent.`,
    );
  } else {
    lines.push("The user has no connected integrations yet.");
  }
  return lines.join("\n");
}

// The client (assistant-ui / useChat) posts the full thread plus optional
// session/model/context extras. `messages` are UIMessages; we keep validation
// loose here and let `convertToModelMessages` enforce the real shape.
const chatStreamSchema = z.object({
  id: z.string().optional(),
  messages: z.array(z.unknown()).min(1, "messages must not be empty"),
  modelId: z.string().optional(),
  /** Host-injected anchor (e.g. the open document in the workspace panel). */
  context: z.object({ type: z.string(), id: z.string(), label: z.string().optional() }).optional(),
});

/** Truncated JSON preview for debug logs (keeps lines readable). */
function preview(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (!s) return "";
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/**
 * Message surfaced to the user when a turn fails (the AI SDK masks errors by
 * default). We pass the provider's own error through — typically the real
 * cause (e.g. a provider key misconfigured in the org's models).
 */
function clientErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const trimmed = msg.trim();
  if (!trimmed)
    return "Le modèle a échoué (erreur inconnue). Vérifiez la configuration des modèles de l'organisation.";
  return `Le modèle a échoué : ${trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed}`;
}

/**
 * Build the caller-context system-prompt block WITHOUT a loopback HTTP hop when
 * possible. Identity (name/email) and role come straight off the request
 * context (already authenticated by the platform pipeline); only the connected
 * integrations need a read, served in-process via the injected platform
 * service. Falls back to the `GET /api/me/context` loopback when the service
 * isn't wired (OSS/tests). Best-effort: any failure degrades to no block ("").
 */
async function buildCallerContextBlock(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: Context<any>,
  args: {
    origin: string;
    headers: Record<string, string>;
    orgId: string;
    applicationId?: string;
    user: { id: string; name?: string | null; email?: string | null };
  },
): Promise<string> {
  const { origin, headers, orgId, applicationId, user } = args;
  const role = (c.get("orgRole") as string | undefined) ?? undefined;
  try {
    const svc = getIntegrationsService();
    if (svc) {
      // In-process: identity/role come from the request context. The connection
      // list is app-scoped — fetch it only when an application id is known;
      // without one we still emit the identity/role block (empty connections)
      // rather than fall back to a loopback that would itself 400 without app
      // context.
      const connections = applicationId
        ? await svc.listUsableForActor({
            orgId,
            applicationId,
            actor: { type: "user", id: user.id },
          })
        : [];
      return formatCallerContext({
        user: { name: user.name ?? null, email: user.email ?? null },
        org: { role: role ?? null },
        connections,
      });
    }
    // Fallback: the original loopback hop (kept for OSS/test wiring).
    const ctxHeaders: Record<string, string> = { ...headers };
    if (applicationId) ctxHeaders["x-application-id"] = applicationId;
    const res = await fetch(new URL("/api/me/context", origin), { headers: ctxHeaders });
    if (res.ok) return formatCallerContext(await res.json());
    return "";
  } catch (err) {
    logger.warn("me/context unavailable — chat degrades without caller context", {
      err: String(err),
    });
    return "";
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleChatStream(c: Context<any>): Promise<Response> {
  const orgId = c.get("orgId") as string;
  const user = c.get("user") as { id: string; email: string; name: string };
  const orgRole = (c.get("orgRole") as string | undefined) ?? "member";
  const body = parseBody(chatStreamSchema, await c.req.json().catch(() => null));
  const messages = body.messages as UIMessage[];
  logger.info("chat turn", { turns: messages.length });

  const origin = selfOrigin();
  const headers = forwardedHeaders(c);

  // Per-turn observability: structured per-step logs to stdout. Full payloads
  // only under CHAT_DEBUG — they may carry PII/customer content.
  const debug = Boolean(process.env.CHAT_DEBUG);
  const turnStart = Date.now();
  let step = 0;
  let stepStart = turnStart;
  let firstChunkAt = 0;

  // The proxy surfaces are bearer-only (cookies refused — CSRF model):
  // inference loopback calls carry a short-lived token only this process
  // can mint, scoped to llm-proxy:call + models:read. The MCP session keeps
  // the caller's own credentials (full RBAC fidelity on tool calls).
  //
  // The token lives 60 s, but a turn fans out into many inference calls over
  // up to MAX_STEPS steps (with a run long-poll blocking for ~55s between
  // them), so we hand modelFromFamily a *minter* — the provider re-mints a fresh
  // bearer on every proxy call. The static header below is for the one-shot
  // calls (listModels) that fire immediately on this same line.
  const mintInferenceAuth = () =>
    mintLoopbackToken({ userId: user.id, email: user.email, name: user.name, orgId, orgRole });
  const inferenceHeaders: Record<string, string> = {
    Authorization: `Bearer ${mintInferenceAuth()}`,
    "X-Org-Id": orgId,
  };

  // ── Preamble phase A (parallel) ──────────────────────────────────────────
  // The model list and the default application id are independent reads, so
  // fire them together rather than back-to-back. `listModels` decides the
  // engine (we read the chosen row's providerId); the app id scopes the MCP
  // + integration reads that follow. Pin from the header when the caller
  // already supplied one (no lookup needed).
  const modelId = c.req.header("X-Model-Id") ?? body.modelId;
  const pinnedAppId = c.req.header("x-application-id");
  const phaseAStart = Date.now();
  const [models, applicationId] = await Promise.all([
    // metadata_only (skip credential decrypt) is safe only when an explicit
    // model is pinned — that id came from the filtered picker, so it's reachable.
    // Without a pin we resolve the org default from the full filtered list, so a
    // dead-credential default is dropped rather than picked → inference error.
    listModels(origin, inferenceHeaders, { metadataOnly: Boolean(modelId) }),
    pinnedAppId
      ? Promise.resolve(pinnedAppId)
      : resolveDefaultApplicationId(origin, headers, orgId),
  ]);
  const chosen = pickModel(models, modelId);
  const phaseAMs = Date.now() - phaseAStart;
  logger.info("model resolved", {
    model: chosen.id,
    modelId: chosen.modelId,
    providerId: chosen.providerId,
  });

  // Subscription engine with a chat surface — the binding AND its chat driver
  // are contributed by the provider module via the shared core registry (the
  // same mapping the run launcher + llm-proxy gateway read), so chat dispatches
  // by provider id WITHOUT importing any vendor SDK. With the module absent
  // there is no `chatHandler` and every provider falls through to the generic
  // ai-sdk path below. Codex maps to a subscription engine too but is agent-only
  // (filtered from the chat model list by CHAT_USABLE_FAMILIES) and contributes
  // no chatHandler — so today only the Claude Agent SDK reaches this branch.
  const subscriptionEngine = subscriptionEngineDef(chosen.providerId ?? "");
  const isSubscription = Boolean(subscriptionEngine?.chatHandler);

  // Platform MCP wiring shared by both engines: the meta-tools live at
  // /api/mcp/o/:org and run with the caller's own credentials (RBAC fidelity).
  const mcpHeaders: Record<string, string> = { ...headers };
  if (applicationId) mcpHeaders["x-application-id"] = applicationId;

  // ── Preamble phase B (parallel) ──────────────────────────────────────────
  // The caller-context block (both paths) and the platform MCP probe (ai-sdk
  // path only) are independent — run them together.
  //
  // The subscription (claude-code) path SKIPS the probe entirely: the official
  // binary opens its OWN MCP connection from `platformMcp.url`, and the MCP
  // server's instructions reach the model through that handshake. A probe here
  // would be a second handshake we'd immediately close (2 round-trips wasted on
  // the TTFT path). We pass `platformMcp` optimistically; if the `mcp` module is
  // absent the SDK just gets no tools.
  let mcp: Awaited<ReturnType<typeof openPlatformMcp>> | null = null;
  // Single MCP-teardown path. The session must be closed on EVERY ai-sdk exit
  // (stream `onError` AND `onFinish`, and a mid-stream client disconnect) or it
  // leaks per turn — close failures are swallowed (warn only) so they never mask
  // the turn result. `await` it on the synchronous paths, `void` in callbacks.
  const closeMcp = async (): Promise<void> => {
    try {
      await mcp?.close();
    } catch (err) {
      logger.warn("mcp close failed", { err: String(err) });
    }
  };

  const phaseBStart = Date.now();
  const contextPromise = buildCallerContextBlock(c, {
    origin,
    headers,
    orgId,
    applicationId,
    user,
  });
  let contextBlock: string;
  if (isSubscription) {
    contextBlock = await contextPromise;
  } else {
    // Graceful degradation: the chat's tools come from the platform MCP module
    // (`/api/mcp/o/:org`). If it's unreachable (e.g. `mcp` not in MODULES), keep
    // the turn usable for plain conversation instead of 500-ing. The UI surfaces
    // a "no tools" banner via the `mcp` app-config feature flag.
    const [openedMcp, block] = await Promise.all([
      openPlatformMcp({ origin, headers, orgId, applicationId }).catch((err) => {
        logger.warn("platform MCP unavailable — chat degrades to no-tools", {
          err: String(err),
        });
        return null;
      }),
      contextPromise,
    ]);
    mcp = openedMcp;
    contextBlock = block;
  }
  const phaseBMs = Date.now() - phaseBStart;

  // Assemble the system prompt. Subscription path: tool-grounding prompt, no
  // inline instructions (the SDK's own MCP handshake delivers them). ai-sdk
  // path: prompt + probe instructions, or the no-tools prompt when MCP is down.
  let system = isSubscription
    ? `${SYSTEM_PROMPT}\n\n${SUBSCRIPTION_TOOLS_NOTE}`
    : !mcp
      ? NO_TOOLS_SYSTEM_PROMPT
      : mcp.instructions
        ? `${SYSTEM_PROMPT}\n\n${mcp.instructions}`
        : SYSTEM_PROMPT;
  if (body.context) {
    system += `\n\nThe user is currently looking at: ${body.context.type} "${body.context.label ?? body.context.id}" (id: ${body.context.id}). Prefer this context when the question is ambiguous.`;
  }
  if (contextBlock) system += `\n\n${contextBlock}`;
  system = applyOperationIndexPolicy(system, chosen.apiShape);

  logger.info("chat preamble", {
    engine: isSubscription ? "subscription" : "ai-sdk",
    providerId: chosen.providerId,
    phaseAMs,
    phaseBMs,
    preambleMs: Date.now() - turnStart,
    hasTools: isSubscription || Boolean(mcp),
  });

  // The credential-injection gateway swaps the placeholder bearer server-side;
  // the real subscription token never enters this process or the spawned
  // binary's env. The gateway slug derives from the provider id — no vendor
  // literal. `platformMcp` is passed unconditionally (see phase B note).
  if (subscriptionEngine?.chatHandler) {
    const loopbackToken = mintLoopbackToken(
      { userId: user.id, email: user.email, name: user.name, orgId, orgRole },
      { ttlMs: ENGINE_LOOPBACK_TTL_MS },
    );
    return subscriptionEngine.chatHandler({
      prompt: buildTranscriptPrompt(messages),
      system,
      modelId: chosen.modelId,
      gatewayBaseUrl: `${origin}/api/llm-proxy/${subscriptionEngine.providerId}-sdk/${encodeURIComponent(chosen.id)}`,
      placeholderToken: loopbackToken,
      platformMcp: { url: platformMcpUrl(origin, orgId), headers: mcpHeaders },
      abortSignal: c.req.raw.signal,
      onError: clientErrorMessage,
    });
  }

  // ai-sdk path — API-key providers only, bound to the llm-proxy.
  const model = modelFromFamily(chosen, origin, inferenceHeaders, mintInferenceAuth);
  if (!model) {
    await closeMcp();
    throw invalidRequest(`Model family "${chosen.apiShape}" is not supported by the chat.`);
  }

  try {
    const result = streamText({
      model,
      // System rides as a cached message part rather than the `system` field:
      // the platform MCP instructions now carry a generated operation index
      // (several KB, re-sent on every one of the up-to-MAX_STEPS inference
      // calls in a turn). OpenAI auto-caches the prefix and the Claude Agent
      // SDK path caches on its own; the ai-sdk Anthropic providers need an
      // explicit cache_control breakpoint or they'd pay the index in full each
      // step. Harmless for non-Anthropic models (providerOptions is namespaced).
      messages: [
        {
          role: "system",
          content: system,
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        },
        ...(await convertToModelMessages(messages)),
      ],
      tools: mcp ? mcp.tools : undefined,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: c.req.raw.signal,
      onChunk: ({ chunk }) => {
        // TTFT marker: log once on the first model output (text or tool call),
        // measured from turn start. The dominant lever this work optimizes.
        if (firstChunkAt === 0 && (chunk.type === "text-delta" || chunk.type === "tool-call")) {
          firstChunkAt = Date.now();
          logger.info("chat first token", { firstTokenMs: firstChunkAt - turnStart });
        }
      },
      onStepFinish: ({ toolCalls, toolResults, finishReason, usage }) => {
        const now = Date.now();
        logger.info("chat step", {
          step: step++,
          finishReason,
          usage: usage as unknown as Record<string, unknown>,
          stepMs: now - stepStart,
          tools: toolCalls.map((t) => t.toolName),
          ...(debug
            ? {
                toolCalls: toolCalls.map((t) => ({ tool: t.toolName, input: preview(t.input) })),
                toolResults: toolResults.map((t) => ({
                  tool: t.toolName,
                  output: preview(t.output),
                })),
              }
            : {}),
        });
        stepStart = now;
      },
      onError: ({ error }) => {
        logger.error("chat stream error", { err: String(error) });
        // AI-SDK fires onError (not onFinish) on a stream failure, so the MCP
        // session must be closed here too or it leaks on every failed turn.
        void closeMcp();
      },
      onFinish: ({ totalUsage, finishReason }) => {
        logger.info("chat turn done", {
          steps: step,
          totalMs: Date.now() - turnStart,
          usage: totalUsage as unknown as Record<string, unknown>,
          finishReason,
        });
        void closeMcp();
      },
    });

    // Close the MCP session if the client disconnects mid-stream.
    c.req.raw.signal.addEventListener("abort", () => void closeMcp(), { once: true });

    // Surface the real failure to the client (AI SDK masks errors otherwise).
    return result.toUIMessageStreamResponse({ onError: clientErrorMessage });
  } catch (err) {
    await closeMcp();
    throw err;
  }
}
