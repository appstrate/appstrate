// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /api/chat/title` — generate a short conversation title with the LLM.
 *
 * The client owns conversation titles (it renames via the session route), but
 * generating a good one needs a model call — and inference only happens through
 * the llm-proxy with a server-minted loopback token. So the client posts the
 * first few messages here; we run a short completion and return the title.
 *
 * Same inference wiring as chat-stream (resolveModel + mintLoopbackToken +
 * streamText). We reuse streamText (not generateText) because the first-party
 * Codex proxy route only serves the streaming shape; `await result.text`
 * collapses it to the final string.
 */

import type { Context } from "hono";
import { streamText } from "ai";
import { z } from "zod";
import { parseBody } from "@appstrate/core/api-errors";
import { logger } from "./logger.ts";
import { resolveModel } from "./llm.ts";
import { selfOrigin } from "./self.ts";
import { mintLoopbackToken } from "./loopback-auth.ts";

const titleSchema = z.object({
  messages: z
    .array(z.object({ role: z.string(), text: z.string() }))
    .min(1)
    .max(8),
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleGenerateTitle(c: Context<any>): Promise<Response> {
  const orgId = c.get("orgId") as string;
  const user = c.get("user") as { id: string; email: string; name: string };
  const orgRole = (c.get("orgRole") as string | undefined) ?? "member";
  const body = parseBody(titleSchema, await c.req.json().catch(() => null));

  const origin = selfOrigin();
  const mintAuth = () =>
    mintLoopbackToken({ userId: user.id, email: user.email, name: user.name, orgId, orgRole });
  const model = await resolveModel({
    origin,
    headers: { Authorization: `Bearer ${mintAuth()}`, "X-Org-Id": orgId },
    mintAuth,
  });

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
