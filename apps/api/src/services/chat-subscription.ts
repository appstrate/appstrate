// SPDX-License-Identifier: Apache-2.0

/**
 * Chat-module platform seam (apps/api side) for the single generic in-process
 * Pi chat engine.
 *
 * `@appstrate/module-chat` owns ONE chat engine that serves every
 * oauth-subscription provider (claude-code, codex) by driving the Pi SDK inline.
 * The module has no DB access, so the two pieces that need it cross through
 * `ctx.services` (wired in `lib/modules/registry.ts`):
 *
 *   - {@link resolveSubscriptionChatModel} — resolve the chosen model row to its
 *     real upstream binding + a FRESH access token (server-side credential
 *     resolution; the real token only leaves as the returned in-memory string).
 *   - {@link recordChatUsage} — insert one `llm_usage` ledger row per turn (the
 *     inline engine meters here, since it no longer flows through the llm-proxy).
 *
 * Both live in apps/api (not the module) because they are wired to api-internal
 * infra — model resolution, credential/token resolution, the `llm_usage` table —
 * and a module must not depend on the API package.
 */

import { db } from "@appstrate/db/client";
import { llmUsage } from "@appstrate/db/schema";
import type { ChatUsageRecord, SubscriptionChatResolution } from "@appstrate/core/chat-contract";
import { getErrorMessage } from "@appstrate/core/errors";
import { loadModel, modelNeedsReconnection } from "./org-models.ts";
import { getModelProvider } from "./model-providers/registry.ts";
import { resolveOAuthTokenForSidecar } from "./model-providers/token-resolver.ts";
import { ApiError } from "../lib/errors.ts";
import { logger } from "../lib/logger.ts";

/**
 * Resolve the chosen chat model preset to its real upstream binding for one
 * chat turn. Only oauth-subscription (authMode `oauth2`) models take the Pi
 * chat-engine path; everything else returns `{ subscription: false }` so the
 * chat module falls through to its generic ai-sdk (llm-proxy) path.
 */
export async function resolveSubscriptionChatModel(
  orgId: string,
  presetId: string,
): Promise<SubscriptionChatResolution> {
  const resolved = await loadModel(orgId, presetId);
  if (!resolved) {
    // A model that resolves to nothing because its oauth credential is flagged
    // needs-reconnection surfaces as a reconnect prompt; anything else (unknown
    // preset, disabled model) falls through to the ai-sdk path, which produces
    // the appropriate "no such model" error.
    if (await modelNeedsReconnection(orgId, presetId)) {
      return { subscription: true, needsReconnection: true };
    }
    return { subscription: false };
  }

  const provider = getModelProvider(resolved.providerId);
  if (!provider || provider.authMode !== "oauth2") {
    return { subscription: false };
  }

  // Fail-closed on an aliased oauth-subscription row (issue #727). Such a row
  // is an invalid state — alias creation AND update reject `aliased` for
  // oauth2 providers, and the run launcher fail-closes on it too
  // (`assertOauthRunNotAliased`) — but a legacy/hand-written row must not make
  // chat quietly execute the real hidden binding while runs refuse it.
  // Falling through to the generic ai-sdk path routes the turn to the LLM
  // gateway, whose oauth-subscription rejection names the alias only.
  if (resolved.aliased) {
    logger.warn("chat: refusing aliased oauth-subscription model (invalid row)", {
      orgId,
      presetId,
      providerId: resolved.providerId,
    });
    return { subscription: false };
  }

  // An oauth2 model with no credential can never be spent — a reconnect (which
  // creates the credential) is the fix, so surface the reconnect prompt rather
  // than a raw error.
  if (!resolved.credentialId) {
    return { subscription: true, needsReconnection: true };
  }

  let token: Awaited<ReturnType<typeof resolveOAuthTokenForSidecar>>;
  try {
    token = await resolveOAuthTokenForSidecar(resolved.credentialId, orgId);
  } catch (err) {
    // `gone()` (HTTP 410) is a refresh-time revocation — surface as reconnect.
    if (err instanceof ApiError && err.status === 410) {
      return { subscription: true, needsReconnection: true };
    }
    throw err;
  }

  return {
    subscription: true,
    model: {
      modelId: resolved.modelId ?? presetId,
      apiShape: resolved.apiShape ?? provider.apiShape,
      baseUrl: resolved.baseUrl ?? provider.defaultBaseUrl,
      cost: resolved.cost ?? null,
      contextWindow: resolved.contextWindow ?? null,
      maxTokens: resolved.maxTokens ?? null,
      reasoning: resolved.reasoning ?? false,
      input: resolved.input ?? null,
      accessToken: token.accessToken,
      ...(token.accountId ? { accountId: token.accountId } : {}),
    },
  };
}

/**
 * Insert one `llm_usage` row for a chat turn. Metering failures MUST NOT break
 * a completed turn (the reply already streamed), so DB errors are logged and
 * swallowed — same posture as `recordProxyUsage`.
 */
export async function recordChatUsage(record: ChatUsageRecord): Promise<void> {
  try {
    await db.insert(llmUsage).values({
      source: "proxy",
      orgId: record.orgId,
      apiKeyId: null,
      userId: record.userId,
      runId: null,
      model: record.presetId,
      realModel: record.modelId,
      api: record.apiShape,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheReadTokens: record.cacheReadTokens ?? null,
      cacheWriteTokens: record.cacheWriteTokens ?? null,
      costUsd: record.costUsd,
      durationMs: record.durationMs,
      requestId: crypto.randomUUID(),
    });
  } catch (err) {
    logger.error("chat: failed to record llm usage", {
      orgId: record.orgId,
      presetId: record.presetId,
      error: getErrorMessage(err),
    });
  }
}
