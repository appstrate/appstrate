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
import { openPlatformMcp } from "./platform-mcp.ts";
import { selfOrigin, forwardedHeaders } from "./self.ts";
import { mintLoopbackToken } from "./loopback-auth.ts";
import { engineForProvider } from "@appstrate/core/subscription-engines";
import { runClaudeAgentChat } from "./claude-agent/engine.ts";
import { runCodexAgentChat } from "./codex-agent/engine.ts";

const MAX_STEPS = 16;

// Heading that fences the generated operation index at the tail of the platform
// MCP server instructions (emitted by apps/api/src/modules/mcp/router.ts). We
// split on this exact literal to drop the index — several KB re-sent on every
// step — for providers without a prompt cache, where it would be re-sent
// uncached every step: Mistral and the Codex engine (the codex CLI is a fresh
// subprocess per turn, so nothing is cached). Cached providers (Claude SDK,
// Anthropic via cache_control, OpenAI auto-prefix) keep it. If this literal
// drifts from the server's, the index simply stays — degraded cost, never a
// failure.
const OPERATION_INDEX_HEADING = "## Operation index";

/**
 * Strip the trailing operation index from the system prompt for providers
 * without a prompt cache, where the multi-KB index would be re-sent uncached on
 * every step: the Codex engine (fresh subprocess per turn) and Mistral. Everyone
 * else keeps it. Tools are unaffected — the agent always has search_operations
 * for discovery when the index is absent.
 */
export function applyOperationIndexPolicy(
  system: string,
  engine: string,
  apiShape: string,
): string {
  const drop = engine === "codex" || apiShape === "mistral-conversations";
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

When a tool call fails with a recoverable error (e.g. a validation error naming a missing or malformed field, or a wrong-endpoint 404), do not stop and report it. Read the error detail, correct the input — re-read the operation schema if needed — and retry, up to a few attempts. Only surface the failure to the user once you have genuinely exhausted reasonable fixes; then show the exact error.`;

// Fallback when the platform MCP module isn't reachable (e.g. `mcp` absent
// from MODULES). The chat keeps working for plain conversation — it just has
// no instance tools — so the prompt drops the tool-grounding instructions and
// tells the model to be upfront about the limitation.
const NO_TOOLS_SYSTEM_PROMPT = `You are Appstrate's assistant. Right now your instance tools are unavailable because the platform MCP module is not active, so you cannot search operations, run agents, inspect runs, or schedule. Answer the user's questions directly and conversationally. If the user asks for an action that needs those tools, say plainly that tools are disabled until the \`mcp\` module is enabled, rather than pretending to act.`;

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

  // The proxy surfaces are bearer-only (cookies refused — CSRF model):
  // inference loopback calls carry a short-lived token only this process
  // can mint, scoped to llm-proxy:call + models:read. The MCP session keeps
  // the caller's own credentials (full RBAC fidelity on tool calls).
  //
  // The token lives 60 s, but a turn fans out into many inference calls over
  // up to MAX_STEPS steps (with a run long-poll blocking for ~55s between
  // them), so we hand resolveModel a *minter* — the provider re-mints a fresh
  // bearer on every proxy call. The static header below is for the one-shot
  // calls (listModels) that fire immediately on this same line.
  const mintInferenceAuth = () =>
    mintLoopbackToken({ userId: user.id, email: user.email, name: user.name, orgId, orgRole });
  const inferenceHeaders: Record<string, string> = {
    Authorization: `Bearer ${mintInferenceAuth()}`,
    "X-Org-Id": orgId,
  };

  // Model chosen in the picker (X-Model-Id), else the request body, else the
  // org default. We pick the org model row first (so we can read its
  // providerId) and only then decide the engine — `claude-code` (Claude
  // subscription) goes through the Agent SDK; everything else through ai-sdk.
  const modelId = c.req.header("X-Model-Id") ?? body.modelId;
  const models = await listModels(origin, inferenceHeaders);
  const chosen = pickModel(models, modelId);
  logger.info("model resolved", {
    model: chosen.id,
    modelId: chosen.modelId,
    providerId: chosen.providerId,
  });
  // App-scoped ops (agents, runs) need an application context; resolve the
  // org's default app unless the caller already pinned one.
  const applicationId =
    c.req.header("x-application-id") ?? (await resolveDefaultApplicationId(origin, headers, orgId));
  // Graceful degradation: the chat's tools come from the platform MCP module
  // (`/api/mcp/o/:org`). If it's unreachable (e.g. `mcp` not in MODULES), keep
  // the turn usable for plain conversation instead of 500-ing. The UI surfaces
  // a "no tools" banner via the `mcp` app-config feature flag.
  let mcp: Awaited<ReturnType<typeof openPlatformMcp>> | null = null;
  try {
    mcp = await openPlatformMcp({ origin, headers, orgId, applicationId });
  } catch (err) {
    logger.warn("platform MCP unavailable — chat degrades to no-tools", { err: String(err) });
  }

  // Per-turn observability: structured per-step logs to stdout. Full payloads
  // only under CHAT_DEBUG — they may carry PII/customer content.
  const debug = Boolean(process.env.CHAT_DEBUG);
  const turnStart = Date.now();
  let step = 0;
  let stepStart = turnStart;

  let system = !mcp
    ? NO_TOOLS_SYSTEM_PROMPT
    : mcp.instructions
      ? `${SYSTEM_PROMPT}\n\n${mcp.instructions}`
      : SYSTEM_PROMPT;
  if (body.context) {
    system += `\n\nThe user is currently looking at: ${body.context.type} "${body.context.label ?? body.context.id}" (id: ${body.context.id}). Prefer this context when the question is ambiguous.`;
  }

  // Platform MCP wiring shared by both engines: the meta-tools live at
  // /api/mcp/o/:org and run with the caller's own credentials (RBAC fidelity).
  const mcpHeaders: Record<string, string> = { ...headers };
  if (applicationId) mcpHeaders["x-application-id"] = applicationId;

  // The provider→engine binding is the shared registry's call (same mapping the
  // run launcher uses), so chat + runs can never disagree on which engine a
  // subscription runs on.
  const engine = engineForProvider(chosen.providerId ?? "");

  system = applyOperationIndexPolicy(system, engine, chosen.apiShape);

  // Subscription engines (claude → Claude Agent SDK, codex → Codex CLI): both
  // are clean/sanctioned official binaries that open their OWN MCP connection,
  // so the prep is identical — close the probe client (used only for
  // reachability + instructions), point the engine at the platform MCP endpoint
  // + forwarded headers, and mint one turn-scoped loopback bearer for the
  // gateway. (For codex the operation index was already stripped by
  // applyOperationIndexPolicy — no prompt cache → it relies on
  // search_operations.) Only the per-engine call (field names + gateway path)
  // differs below.
  if (engine === "claude" || engine === "codex") {
    const platformMcp = mcp
      ? { url: `${origin}/api/mcp/o/${encodeURIComponent(orgId)}`, headers: mcpHeaders }
      : undefined;
    await mcp?.close();
    const loopbackToken = mintLoopbackToken(
      { userId: user.id, email: user.email, name: user.name, orgId, orgRole },
      { ttlMs: ENGINE_LOOPBACK_TTL_MS },
    );
    if (engine === "claude") {
      return runClaudeAgentChat({
        messages,
        system,
        modelId: chosen.modelId,
        gatewayBaseUrl: `${origin}/api/llm-proxy/claude-code-sdk/${encodeURIComponent(chosen.id)}`,
        placeholderToken: loopbackToken,
        platformMcp,
        abortSignal: c.req.raw.signal,
        onError: clientErrorMessage,
      });
    }
    return runCodexAgentChat({
      messages,
      system,
      modelId: chosen.modelId,
      credentialUrl: `${origin}/api/llm-proxy/codex-sdk/${encodeURIComponent(chosen.id)}`,
      loopbackToken,
      platformMcp,
      abortSignal: c.req.raw.signal,
      onError: clientErrorMessage,
    });
  }

  // ai-sdk path — API-key providers only, bound to the llm-proxy.
  const model = modelFromFamily(chosen, origin, inferenceHeaders, mintInferenceAuth);
  if (!model) {
    await mcp?.close();
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
        void mcp?.close().catch((err) => logger.warn("mcp close failed", { err: String(err) }));
      },
      onFinish: ({ totalUsage, finishReason }) => {
        logger.info("chat turn done", {
          steps: step,
          totalMs: Date.now() - turnStart,
          usage: totalUsage as unknown as Record<string, unknown>,
          finishReason,
        });
        void mcp?.close().catch((err) => logger.warn("mcp close failed", { err: String(err) }));
      },
    });

    // Close the MCP session if the client disconnects mid-stream.
    c.req.raw.signal.addEventListener(
      "abort",
      () => void mcp?.close().catch((err) => logger.warn("mcp close failed", { err: String(err) })),
      { once: true },
    );

    // Surface the real failure to the client (AI SDK masks errors otherwise).
    return result.toUIMessageStreamResponse({ onError: clientErrorMessage });
  } catch (err) {
    await mcp?.close();
    throw err;
  }
}
