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
 *   - {@link resolveChatModel} — resolve the chosen model row to its
 *     real upstream binding + a FRESH access token (server-side credential
 *     resolution; the real token only leaves as the returned in-memory string).
 *   - {@link recordChatUsage} — insert one `llm_usage` ledger row per turn (the
 *     inline engine meters here, since it no longer flows through the llm-proxy).
 *
 * Both live in apps/api (not the module) because they are wired to api-internal
 * infra — model resolution, credential/token resolution, the `llm_usage` table —
 * and a module must not depend on the API package.
 */

import type { ChatUsageRecord, ChatModelResolution } from "@appstrate/core/chat-contract";
import type { UsageRejection } from "@appstrate/core/module";
import { parseTokenUsage, type TokenUsage } from "@appstrate/afps-shared/token-usage";
import type { ModelPayer } from "@appstrate/core/model-payer";
import { getErrorMessage } from "@appstrate/core/errors";
import { recordLlmUsageReliably } from "./llm-usage-retry.ts";
import { resolvePricingStatus } from "./pricing-provenance.ts";
import { cumulativeCostUsd } from "./token-cost.ts";
import {
  credentialPayer,
  loadModel,
  modelNeedsReconnection,
  requireBoundModel,
} from "./org-models.ts";
import { loadCredentialBinding } from "./model-providers/credentials.ts";
import { getModelProvider } from "./model-providers/registry.ts";
import { resolveOAuthTokenForSidecar } from "./model-providers/token-resolver.ts";
import { isOrgDeletionReserved, orgDeletingError } from "./state/runs.ts";
import { callHook, hasHook } from "../lib/modules/module-loader.ts";
import { ApiError } from "../lib/errors.ts";
import { logger } from "../lib/logger.ts";
import { db } from "@appstrate/db/client";

/**
 * Resolve the chosen chat model preset to its real upstream binding for one
 * chat turn, for the session user `userId` (their own subscription serves a model
 * the organization leaves unbound). Only oauth-subscription (authMode `oauth2`)
 * models take the Pi chat-engine path; everything else returns
 * `{ subscription: false }` so the chat module binds the same engine to the
 * llm-proxy instead.
 */
export async function resolveChatModel(
  orgId: string,
  presetId: string,
  userId: string,
): Promise<ChatModelResolution> {
  const resolved = await loadModel(orgId, presetId, userId);
  if (!resolved) {
    // A model that resolves to nothing because its stored credential is dead —
    // oauth flagged needs-reconnection, or (either auth mode) a secret that no
    // longer decrypts — surfaces as a reconnect prompt; anything else (unknown
    // preset, disabled model) falls through to the API-key branch, which
    // produces the appropriate "no such model" error. Reached only after `loadModel`
    // already returned null, so nothing is resolvable and no spend can happen
    // on either branch: this only decides which error the user is shown, and
    // "reconnect that credential" is the actionable one.
    if (await modelNeedsReconnection(orgId, presetId, userId)) {
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
  // Falling through to the API-key branch routes the turn to the LLM gateway,
  // whose oauth-subscription rejection names the alias only.
  if (resolved.aliased) {
    logger.warn("chat: refusing aliased oauth-subscription model (invalid row)", {
      orgId,
      presetId,
      providerId: resolved.providerId,
    });
    return { subscription: false };
  }

  // An unbound subscription model names no credential the user can spend: a dead
  // one of theirs asks for a reconnect, none at all for a credential to add.
  if (
    resolved.credentialSource === null &&
    (await modelNeedsReconnection(orgId, presetId, userId))
  ) {
    return { subscription: true, needsReconnection: true };
  }
  const { credentialId } = requireBoundModel(resolved, userId);
  if (!credentialId) {
    return { subscription: true, needsReconnection: true };
  }

  let token: Awaited<ReturnType<typeof resolveOAuthTokenForSidecar>>;
  try {
    token = await resolveOAuthTokenForSidecar(credentialId, orgId);
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
      apiShape: resolved.apiShape,
      baseUrl: resolved.baseUrl ?? provider.defaultBaseUrl,
      cost: resolved.cost ?? null,
      contextWindow: resolved.contextWindow ?? null,
      maxTokens: resolved.maxTokens ?? null,
      reasoning: resolved.reasoning ?? false,
      input: resolved.input ?? null,
      credentialId,
      accessToken: token.accessToken,
    },
  };
}

/**
 * Insert one `llm_usage` row for a chat turn via the single ledger writer.
 * Metering failures MUST NOT break a completed turn (the reply already
 * streamed), so DB errors are logged and swallowed — same posture as
 * `recordProxyUsage`.
 *
 * The in-process engine serves subscriptions only (oauth2 claude-code/codex).
 * The row's payer is derived here from the credential that served the turn, never
 * taken from the module: a member's own subscription stamps `credentialSource="user"`
 * with that member as `payerUserId`, an organization subscription `"org"` with no
 * payer. Cost is derived here from the token counts + the
 * model's catalog rates with Pi's `calculateCost`, like the proxy/runner rows.
 * Its tier bands (`record.tiers`) price each model call at its tier.
 *
 * KNOWN LABELLING GAP — `source: "proxy"` is inaccurate for this producer. The
 * turn runs on the IN-PROCESS Pi engine and never traverses `/api/llm-proxy/*`,
 * but `llm_usage.source` is a two-value enum (`proxy | runner`) documented to
 * modules as "the inference proxy or the agent runner", and the settled
 * predicate keys off `source <> 'runner'`. A third value is a DB enum change +
 * migration + core contract change, all outside this file's remit. `proxy` is
 * the correct choice among the two available: the row IS immutable at insert
 * (settled immediately), which is exactly what the predicate needs. The
 * attribution that actually matters downstream — `chat_session_id`,
 * `credential_source` — is exact.
 */
export async function recordChatUsage(record: ChatUsageRecord): Promise<void> {
  // Floor every count at zero: a negative token count would yield a negative
  // `cost_usd`, which SUBTRACTS from the org's ledger (nothing re-checks the
  // sign downstream). Same guard as the proxy adapters' `tokenCount`.
  const inputTokens = Math.max(0, record.inputTokens);
  const outputTokens = Math.max(0, record.outputTokens);
  const cacheReadTokens =
    record.cacheReadTokens === undefined || record.cacheReadTokens === null
      ? null
      : Math.max(0, record.cacheReadTokens);
  const cacheWriteTokens =
    record.cacheWriteTokens === undefined || record.cacheWriteTokens === null
      ? null
      : Math.max(0, record.cacheWriteTokens);
  // Malformed bands price at base rather than fail a turn that already streamed.
  const { usage: banded, tiersDropped } = parseTokenUsage({ tiers: record.tiers });
  if (tiersDropped) {
    logger.warn("usage: malformed tier bands dropped", {
      orgId: record.orgId,
      presetId: record.presetId,
      seam: "chat",
    });
  }
  const tiers = banded?.tiers;
  // The four buckets as the shared helpers consume them — built once and reused
  // for both the cost and its provenance so the two can never describe
  // different numbers.
  const usage: TokenUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadTokens ?? 0,
    cache_creation_input_tokens: cacheWriteTokens ?? 0,
    ...(tiers?.length ? { tiers } : {}),
  };
  // NOT a "subscription models are free" carve-out: a subscription preset
  // (codex → openai, claude-code → anthropic) resolves its rates through
  // `catalogProviderId`, so `record.cost` is non-null and the turn classifies
  // `priced`. That price is an imputed API-equivalent, deliberately — the org
  // spends its own subscription, and the platform still records what the same
  // consumption would have cost. `unpriced` on such a turn would be a bug, not
  // a truth: it would mark a row the platform CAN price as unpriceable.
  const pricingStatus = resolvePricingStatus({
    orgId: record.orgId,
    model: record.presetId,
    usage,
    cost: record.cost,
    context: { source: "chat", chatSessionId: record.chatSessionId, realModel: record.modelId },
  });
  try {
    const { credentialSource, payerUserId } = record.credentialId
      ? credentialPayer(
          (await loadCredentialBinding(record.orgId, record.credentialId))?.ownerUserId,
        )
      : { credentialSource: null, payerUserId: undefined };
    await recordLlmUsageReliably(
      {
        source: "proxy",
        orgId: record.orgId,
        userId: record.userId,
        chatSessionId: record.chatSessionId,
        model: record.presetId,
        realModel: record.modelId,
        api: record.apiShape,
        credentialId: record.credentialId,
        credentialSource,
        payerUserId: payerUserId ?? null,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        costUsd: cumulativeCostUsd(usage, record.cost),
        pricingStatus,
        durationMs: record.durationMs,
        // Stable across durable retries; the partial unique index makes an
        // uncertain post-commit acknowledgement idempotent.
        requestId: crypto.randomUUID(),
      },
      { onConflict: "proxy-idempotent" },
    );
  } catch (err) {
    logger.error("chat: failed to record llm usage", {
      orgId: record.orgId,
      presetId: record.presetId,
      error: getErrorMessage(err),
    });
  }
}

/**
 * Chat admission gate — the chat-surface entry into the `beforeUsage` hook.
 *
 * The chat module calls this before starting ANY turn — built-in, API-key, or
 * oauth-subscription. The gate resolves who pays SERVER-SIDE (`loadModel` and
 * `requireBoundModel` for the session user) so the chat module stays dumb — it
 * has no model-registry access — but that resolution is REPORTED as
 * the `credentialSource` fact, not used to pre-filter:
 *
 *   - every turn dispatches `beforeUsage` (chat context) with
 *     `credentialSource` + `executionPlane`; a rejection flows back for the
 *     module to surface as an RFC 9457 problem response.
 *   - a turn on the org's own credential reports `credentialSource: "org"`. The
 *     platform no longer declares it free and skips the hook: a chat turn always
 *     runs inside the platform's own process, so the platform funds its compute
 *     even when it funds no inference. A module that meters only
 *     platform-supplied inference quotes that turn at zero and admits it — same
 *     outcome as the old early return, but decided by the module.
 *   - a turn on the session user's own credential (key or subscription)
 *     reports `"user"`. A subscription turn dispatches like any other: it runs
 *     inline in the platform's process, so the platform funds its compute and
 *     a module gating on subscription status must be able to refuse it.
 *
 * A turn on an unbound model (no credential the session user can spend) is
 * refused with `model_credential_required` before dispatch. A model that
 * resolves to nothing reports nothing: no spend can happen, and the turn is
 * refused downstream.
 *
 * Returns null when no module provides the hook (OSS mode allows everything),
 * except for a reserved deletion, which refuses whatever the deployment loads.
 */
export async function checkUsageAllowed(args: {
  orgId: string;
  presetId: string;
  sessionId: string | null;
  userId: string;
}): Promise<UsageRejection | null> {
  // Returned, not thrown: this seam renders a rejection as the problem response.
  const err = (await isOrgDeletionReserved(db, args.orgId)) ? orgDeletingError() : null;
  if (err) return { code: err.code, message: err.message, status: err.status };

  // A platform rule, not an admission decision: it holds with or without a module.
  // A model the organization leaves to each member, which the session user holds
  // no credential for, is refused here.
  const resolved = await loadModel(args.orgId, args.presetId, args.userId);
  // Nothing resolves, so nothing can be spent: the turn is refused downstream
  // (unknown model, or a credential to reconnect) and there is no payer to report.
  if (resolved === null) return null;
  let credentialSource: ModelPayer;
  try {
    credentialSource = requireBoundModel(resolved, args.userId).credentialSource;
  } catch (err) {
    if (err instanceof ApiError) {
      return { code: err.code, message: err.message, status: err.status };
    }
    throw err;
  }

  if (!hasHook("beforeUsage")) return null;
  const rejection = await callHook("beforeUsage", {
    orgId: args.orgId,
    context: "chat",
    sessionId: args.sessionId,
    // A chat turn resolves its model on the platform before admission, so the
    // credential source is always determinable here (never `null`, unlike a
    // remote-origin run).
    credentialSource,
    // A turn executes in the platform's own process — never on a
    // caller-supplied host. True of the in-process chat engine too.
    executionPlane: "platform",
  });
  return rejection ?? null;
}
