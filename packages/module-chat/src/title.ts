// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /api/chat/title` — generate a short conversation title with the LLM.
 *
 * The client owns conversation titles (it renames via the session route), but
 * generating a good one needs a model call. We route exactly like the chat
 * turn: **subscription** models (codex / claude-code) go through their own
 * ToS-clean engine — the llm-proxy refuses them — and **api-key** models go
 * through the proxy via `streamText`. Picking only api-key models here used to
 * leave subscription-only orgs (e.g. codex default) with no working title path.
 */

import type { Context } from "hono";
import { streamText, type UIMessage } from "ai";
import { z } from "zod";
import { parseBody } from "@appstrate/core/api-errors";
import { logger } from "./logger.ts";
import { listModels, pickModel, modelFromFamily } from "./llm.ts";
import { CLAUDE_CODE_PROVIDER_ID, CODEX_PROVIDER_ID } from "./chat-families.ts";
import { selfOrigin } from "./self.ts";
import { mintLoopbackToken } from "./loopback-auth.ts";
import { runClaudeAgentChat } from "./claude-agent/engine.ts";
import { runCodexAgentChat } from "./codex-agent/engine.ts";

/** A title turn is one short completion — a few minutes of TTL is ample. */
const ENGINE_TTL_MS = 5 * 60_000;

const titleSchema = z.object({
  messages: z
    .array(z.object({ role: z.string(), text: z.string() }))
    .min(1)
    .max(8),
});

const SYSTEM =
  "Tu génères un titre court (3 à 6 mots) qui résume la conversation. " +
  "Réponds uniquement par le titre, sans guillemets ni ponctuation finale.";

/**
 * Self-contained titling instruction. Framed as "title THIS data", not a turn to
 * continue — an agentic engine (codex) otherwise *answers* the conversation
 * instead of titling it. The whole instruction lives in the user message so it
 * survives prompt flattening, independent of how each path treats `system`.
 */
function titlePrompt(conversation: string): string {
  return (
    "Donne un titre court (3 à 6 mots) résumant la conversation ci-dessous. " +
    "Réponds UNIQUEMENT par le titre — pas de phrase, pas de liste, pas de guillemets, " +
    "pas de ponctuation finale.\n\n--- Conversation ---\n" +
    conversation
  );
}

/**
 * Keep the first non-empty line, then strip wrapping quotes/space and trailing
 * punctuation. First-line keeps us robust if a model prepends a stray word or
 * appends an explanation despite the instruction.
 */
export function cleanTitle(raw: string): string {
  const firstLine = raw.split("\n").find((l) => l.trim().length > 0) ?? "";
  return firstLine
    .trim()
    .replace(/^["'«»\s]+/, "")
    .replace(/["'«».\s]+$/, "")
    .slice(0, 80);
}

/**
 * Concatenate the assistant text from an engine's UI-message-stream Response.
 * The engines return a streamed Response of UI chunks (SSE `data: {chunk}`); a
 * title only needs the `text-delta` deltas. Tolerant of both SSE-framed and bare
 * JSON lines so a wire-format tweak degrades to an empty title, never a throw.
 */
export async function collectStreamText(res: Response): Promise<string> {
  if (!res.ok || !res.body) return "";
  const raw = await res.text();
  let out = "";
  for (const line of raw.split("\n")) {
    let t = line.trim();
    if (t.startsWith("data:")) t = t.slice(5).trim();
    if (!t || t[0] !== "{") continue;
    try {
      const chunk = JSON.parse(t) as { type?: string; delta?: string };
      if (chunk.type === "text-delta" && typeof chunk.delta === "string") out += chunk.delta;
    } catch {
      // keep-alive / non-JSON frame — skip
    }
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleGenerateTitle(c: Context<any>): Promise<Response> {
  const orgId = c.get("orgId") as string;
  const user = c.get("user") as { id: string; email: string; name: string };
  const orgRole = (c.get("orgRole") as string | undefined) ?? "member";
  const body = parseBody(titleSchema, await c.req.json().catch(() => null));

  const origin = selfOrigin();
  const identity = { userId: user.id, email: user.email, name: user.name, orgId, orgRole };
  const mintAuth = () => mintLoopbackToken(identity);
  const inferenceHeaders = { Authorization: `Bearer ${mintAuth()}`, "X-Org-Id": orgId };

  const conversation = body.messages.map((m) => `${m.role}: ${m.text}`).join("\n");
  const prompt = titlePrompt(conversation);

  try {
    const chosen = pickModel(
      await listModels(origin, inferenceHeaders),
      c.req.header("X-Model-Id"),
    );

    // Subscription models → their own engine (no platform tools needed for a
    // title, so no `platformMcp`). The engine streams; we collect the text.
    if (chosen.providerId === CLAUDE_CODE_PROVIDER_ID) {
      const res = runClaudeAgentChat({
        messages: [titleMessage(prompt)],
        system: SYSTEM,
        modelId: chosen.modelId,
        gatewayBaseUrl: `${origin}/api/llm-proxy/claude-code-sdk/${encodeURIComponent(chosen.id)}`,
        placeholderToken: mintLoopbackToken(identity, { ttlMs: ENGINE_TTL_MS }),
        localTools: { origin, headers: {} },
        abortSignal: c.req.raw.signal,
        onError: () => "",
      });
      return c.json({ title: cleanTitle(await collectStreamText(res)) });
    }
    if (chosen.providerId === CODEX_PROVIDER_ID) {
      const res = runCodexAgentChat({
        messages: [titleMessage(prompt)],
        system: SYSTEM,
        modelId: chosen.modelId,
        credentialUrl: `${origin}/api/llm-proxy/codex-sdk/${encodeURIComponent(chosen.id)}`,
        loopbackToken: mintLoopbackToken(identity, { ttlMs: ENGINE_TTL_MS }),
        abortSignal: c.req.raw.signal,
        onError: () => "",
      });
      return c.json({ title: cleanTitle(await collectStreamText(res)) });
    }

    // api-key model → llm-proxy via streamText (`await result.text` collapses the
    // stream to the final string).
    const model = modelFromFamily(chosen, origin, inferenceHeaders, mintAuth);
    if (!model) return c.json({ title: "" });
    const result = streamText({
      model,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
      abortSignal: c.req.raw.signal,
      onError: ({ error }) => logger.warn("title stream error", { err: String(error) }),
    });
    return c.json({ title: cleanTitle(await result.text) });
  } catch (err) {
    // The client falls back to a trimmed first message — never block on title.
    logger.warn("title generation failed", { err: String(err) });
    return c.json({ title: "" });
  }
}

/** The conversation as a single user message for the engine path. */
function titleMessage(conversation: string): UIMessage {
  return { id: "title", role: "user", parts: [{ type: "text", text: conversation }] } as UIMessage;
}
