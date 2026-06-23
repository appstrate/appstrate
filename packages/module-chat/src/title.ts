// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /api/chat/title` — generate a short conversation title with the LLM.
 *
 * The client owns conversation titles (it renames via the session route), but
 * generating a good one needs a model call — and inference only happens through
 * the llm-proxy with a server-minted loopback token. So the client posts the
 * first few messages here; we run a short completion and return the title.
 *
 * Title generation goes through the SAME model selection + engine dispatch as
 * the main turn (chat-stream.ts), so a model can never be resolved one way for
 * the turn and another way for its title:
 *
 *   - API-key families (anthropic-messages, openai-completions,
 *     mistral-conversations) → a one-shot `streamText` bound to the llm-proxy.
 *   - Subscription engines (e.g. `claude-code`, `codex`) → NOT routed through
 *     the generic llm-proxy path. Their credential only works through the
 *     official-binary `-sdk` gateway, so resolving such a model through the
 *     generic proxy would either misroute (a non-subscription anthropic route
 *     that refuses the credential) or silently produce nothing. A subscription
 *     model MUST hard-refuse here rather than fall through. Spawning the full
 *     official binary (with MCP tools) just to name a conversation is the wrong
 *     trade-off for a best-effort title, so we explicitly SKIP LLM title
 *     generation for subscription engines and return an empty title with a
 *     clear `reason` — the client falls back to a trimmed first message. This
 *     is an explicit, logged decision, never a silent empty string.
 */

import type { Context } from "hono";
import { streamText } from "ai";
import { z } from "zod";
import { parseBody } from "@appstrate/core/api-errors";
import { subscriptionEngineDef } from "@appstrate/core/subscription-engines";
import { logger } from "./logger.ts";
import { listModels, pickModel, modelFromFamily } from "./llm.ts";
import { selfOrigin } from "./self.ts";
import { mintLoopbackToken } from "./loopback-auth.ts";

const titleSchema = z.object({
  messages: z
    .array(z.object({ role: z.string(), text: z.string() }))
    .min(1)
    .max(8),
  /** Optional: title with the SAME model the turn used (else the org default). */
  modelId: z.string().optional(),
});

const SYSTEM =
  "Tu génères un titre court (3 à 6 mots) qui résume la conversation. " +
  "Réponds uniquement par le titre, sans guillemets ni ponctuation finale.";

/** Strip wrapping quotes/space and trailing punctuation a model may add. */
export function cleanTitle(raw: string): string {
  return raw
    .trim()
    .replace(/^["'«»\s]+/, "")
    .replace(/["'«».\s]+$/, "")
    .slice(0, 80);
}

/**
 * Decide how a given provider's model is titled. Kept pure (no IO) so the
 * routing decision is unit-testable in isolation from the model fetch.
 *
 *  - `"proxy"`  — an API-key family: run a one-shot completion via the llm-proxy.
 *  - `"skip"`   — a subscription engine (claude-code / codex …): the credential
 *    only works through the official-binary `-sdk` gateway, so the generic
 *    proxy path would misroute or silently yield nothing. We refuse it here and
 *    let the client fall back to a trimmed first message. The reason is carried
 *    so the response (and the log) is explicit, never a bare empty string.
 */
export function titleRouteForProvider(providerId: string | undefined): "proxy" | "skip" {
  return subscriptionEngineDef(providerId ?? "") ? "skip" : "proxy";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleGenerateTitle(c: Context<any>): Promise<Response> {
  const orgId = c.get("orgId") as string;
  const user = c.get("user") as { id: string; email: string; name: string };
  const orgRole = (c.get("orgRole") as string | undefined) ?? "member";
  const body = parseBody(titleSchema, await c.req.json().catch(() => null));

  const origin = selfOrigin();
  const mintAuth = () =>
    mintLoopbackToken({ userId: user.id, email: user.email, name: user.name, orgId, orgRole });
  const inferenceHeaders = { Authorization: `Bearer ${mintAuth()}`, "X-Org-Id": orgId };

  // Same selection as the main turn: pick the org model row first so we can
  // read its `providerId` and decide the engine BEFORE building any model —
  // exactly as chat-stream does. A subscription model must not slip through the
  // generic proxy resolver.
  const modelId = c.req.header("X-Model-Id") ?? body.modelId;
  const models = await listModels(origin, inferenceHeaders);
  const chosen = pickModel(models, modelId);

  if (titleRouteForProvider(chosen.providerId) === "skip") {
    // Subscription engine (claude-code / codex …): the generic llm-proxy path
    // can't serve its credential, and spawning the official binary for a title
    // is the wrong trade-off. Refuse explicitly; the client titles from the
    // first message. Logged + reasoned, never a silent empty string.
    logger.info("title generation skipped for subscription engine", {
      model: chosen.id,
      providerId: chosen.providerId,
    });
    return c.json({ title: "", reason: "subscription-engine" });
  }

  const model = modelFromFamily(chosen, origin, inferenceHeaders, mintAuth);
  if (!model) {
    logger.warn("title generation: unsupported model family", {
      model: chosen.id,
      family: chosen.apiShape,
    });
    return c.json({ title: "", reason: "unsupported-family" });
  }

  const conversation = body.messages.map((m) => `${m.role}: ${m.text}`).join("\n");
  try {
    // Mirror chat-stream's working shape: `messages` (not `prompt`), no token
    // cap (reasoning models need budget; the prompt keeps output to a few words).
    const result = streamText({
      model,
      system: SYSTEM,
      messages: [{ role: "user", content: conversation }],
      abortSignal: c.req.raw.signal,
      onError: ({ error }) => {
        const e = error as { message?: string; statusCode?: number; responseBody?: string };
        logger.warn("title stream error", {
          msg: e.message,
          status: e.statusCode,
          body: e.responseBody,
        });
      },
    });
    return c.json({ title: cleanTitle(await result.text) });
  } catch (err) {
    // The client falls back to a trimmed first message — never block on title.
    logger.warn("title generation failed", { err: String(err) });
    return c.json({ title: "" });
  }
}
