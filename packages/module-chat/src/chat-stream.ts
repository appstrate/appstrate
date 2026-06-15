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
import { streamText, convertToModelMessages, stepCountIs, tool, type UIMessage } from "ai";
import { z } from "zod";
import { parseBody } from "@appstrate/core/api-errors";
import { logger } from "./logger.ts";
import { resolveModel, resolveDefaultApplicationId } from "./llm.ts";
import { openPlatformMcp } from "./platform-mcp.ts";
import { createWaitForRunTool } from "./wait-for-run.ts";
import { selfOrigin, forwardedHeaders } from "./self.ts";
import { mintLoopbackToken } from "./loopback-auth.ts";

const MAX_STEPS = 16;

const SYSTEM_PROMPT = `You are Appstrate's assistant. You help the user operate their Appstrate instance — discovering and running agents, inspecting runs, scheduling, searching their documents — through the available tools.

Use the tools to ground every action: search for the right operation, read its schema, then invoke it. Never invent an operationId or argument shape. Runs are asynchronous — after triggering one, call \`wait_for_run\` with the returned runId and let it block until completion; never poll getRun in a loop yourself. Cite what the tools return; do not fabricate results.

When a tool call fails with a recoverable error (e.g. a validation error naming a missing or malformed field, or a wrong-endpoint 404), do not stop and report it. Read the error detail, correct the input — re-read the operation schema if needed — and retry, up to a few attempts. Only surface the failure to the user once you have genuinely exhausted reasonable fixes; then show the exact error.

When the best answer is a self-contained visual — a chart, a diagram, a mockup, a small interactive demo — call \`render_html\` with one complete HTML document (inline CSS/JS only; no external network). It renders sandboxed in the user's browser as a live artifact. Use it for things worth *seeing*, not for prose or code the user just wants to read.`;

/**
 * Client-rendered artifact tool. The `execute` is a no-op ack so the model
 * keeps streaming after the call; the HTML lives in the call args and the
 * browser renders it sandboxed (see RenderHtmlToolUI). No server work, no
 * Appstrate capability — pure front rendering.
 */
const renderHtmlTool = tool({
  description:
    "Render a complete, self-contained HTML document as a live artifact shown inline to the user. " +
    "Inline CSS/JS allowed; no external network. Use for visualizations, diagrams, mockups, or small demos.",
  inputSchema: z.object({
    code: z.string().describe("The complete, self-contained HTML document to render."),
    title: z.string().optional().describe("Short title for the artifact."),
  }),
  execute: async () => ({ rendered: true }),
});

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
  // up to MAX_STEPS steps (with wait_for_run blocking for minutes between
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
  // org default — resolveModel picks the org default when none is given.
  const modelId = c.req.header("X-Model-Id") ?? body.modelId;
  const model = await resolveModel({
    origin,
    headers: inferenceHeaders,
    modelId,
    mintAuth: mintInferenceAuth,
  });
  // App-scoped ops (agents, runs) need an application context; resolve the
  // org's default app unless the caller already pinned one.
  const applicationId =
    c.req.header("x-application-id") ?? (await resolveDefaultApplicationId(origin, headers, orgId));
  const mcp = await openPlatformMcp({ origin, headers, orgId, applicationId });

  // Per-turn observability: structured per-step logs to stdout. Full payloads
  // only under CHAT_DEBUG — they may carry PII/customer content.
  const debug = Boolean(process.env.CHAT_DEBUG);
  const turnStart = Date.now();
  let step = 0;
  let stepStart = turnStart;

  let system = mcp.instructions ? `${SYSTEM_PROMPT}\n\n${mcp.instructions}` : SYSTEM_PROMPT;
  if (body.context) {
    system += `\n\nThe user is currently looking at: ${body.context.type} "${body.context.label ?? body.context.id}" (id: ${body.context.id}). Prefer this context when the question is ambiguous.`;
  }

  try {
    const result = streamText({
      model,
      system,
      messages: await convertToModelMessages(messages),
      tools: {
        ...mcp.tools,
        wait_for_run: createWaitForRunTool(mcp.tools),
        render_html: renderHtmlTool,
      },
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: c.req.raw.signal,
      // Codex (ChatGPT) backend quirks, ignored by non-OpenAI providers:
      //  - `store: false` is mandatory.
      //  - it requires the top-level `instructions` field — the Responses
      //    provider only sets it from `providerOptions.openai.instructions`.
      providerOptions: { openai: { store: false, instructions: system } },
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
      onError: ({ error }) => logger.error("chat stream error", { err: String(error) }),
      onFinish: ({ totalUsage, finishReason }) => {
        logger.info("chat turn done", {
          steps: step,
          totalMs: Date.now() - turnStart,
          usage: totalUsage as unknown as Record<string, unknown>,
          finishReason,
        });
        void mcp.close();
      },
    });

    // Close the MCP session if the client disconnects mid-stream.
    c.req.raw.signal.addEventListener("abort", () => void mcp.close(), { once: true });

    // Surface the real failure to the client (AI SDK masks errors otherwise).
    return result.toUIMessageStreamResponse({ onError: clientErrorMessage });
  } catch (err) {
    await mcp.close();
    throw err;
  }
}
