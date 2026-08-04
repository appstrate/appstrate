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

import type { ChatUsageRecord, SubscriptionChatResolution } from "@appstrate/core/chat-contract";
import type { UsageRejection } from "@appstrate/core/module";
import { getErrorMessage } from "@appstrate/core/errors";
import { computeTokenCost } from "@appstrate/afps-runtime/runner";
import { recordLlmUsageReliably } from "./llm-usage-retry.ts";
import { resolvePricingStatus } from "./pricing-provenance.ts";
import { loadModel, modelNeedsReconnection } from "./org-models.ts";
import { isSystemModel } from "./model-registry.ts";
import { getModelProvider } from "./model-providers/registry.ts";
import { resolveOAuthTokenForSidecar } from "./model-providers/token-resolver.ts";
import { callHook, hasHook } from "../lib/modules/module-loader.ts";
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
    // A model that resolves to nothing because its stored credential is dead —
    // oauth flagged needs-reconnection, or (either auth mode) a secret that no
    // longer decrypts — surfaces as a reconnect prompt; anything else (unknown
    // preset, disabled model) falls through to the ai-sdk path, which produces
    // the appropriate "no such model" error. Reached only after `loadModel`
    // already returned null, so nothing is resolvable and no spend can happen
    // on either branch: this only decides which error the user is shown, and
    // "reconnect that credential" is the actionable one.
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
      apiShape: resolved.apiShape,
      baseUrl: resolved.baseUrl ?? provider.defaultBaseUrl,
      cost: resolved.cost ?? null,
      contextWindow: resolved.contextWindow ?? null,
      maxTokens: resolved.maxTokens ?? null,
      reasoning: resolved.reasoning ?? false,
      reasoningLevelMap: resolved.generation?.reasoning.nativeLevels,
      input: resolved.input ?? null,
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
 * The subscription chat path spends the user's OWN provider subscription
 * (oauth2 claude-code/codex), so the row is always stamped
 * `credentialSource="org"`. Cost is derived here from the token counts + the
 * model's catalog rates with the shared `computeTokenCost` formula — the same
 * source and arithmetic as the proxy/runner rows.
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
  // The four buckets as the shared helpers consume them — built once and reused
  // for both the cost and its provenance so the two can never describe
  // different numbers.
  const usage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadTokens ?? 0,
    cache_creation_input_tokens: cacheWriteTokens ?? 0,
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
    await recordLlmUsageReliably(
      {
        source: "proxy",
        orgId: record.orgId,
        userId: record.userId,
        chatSessionId: record.chatSessionId,
        model: record.presetId,
        realModel: record.modelId,
        api: record.apiShape,
        credentialSource: "org",
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        costUsd: computeTokenCost(usage, record.cost),
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
 * oauth-subscription. The gate resolves system-provided vs. org-owned
 * SERVER-SIDE (`isSystemModel` on the chosen preset) so the chat module stays
 * dumb — it has no model-registry access — but that resolution is REPORTED as
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
 *   - a SUBSCRIPTION turn (`args.subscription`) is `"org"` whatever its preset
 *     resolves to: it spends the organization's own OAuth provider
 *     subscription. That is the single fact the chat module reports here
 *     (it owns the engine choice, the platform owns the registry), and it is
 *     what stops the derivation below from mislabelling such a turn — a
 *     subscription preset that happened to be registered system-side would
 *     otherwise read as `"system"`. The turn dispatches like any other: it runs
 *     inline in the platform's process, so the platform funds its compute and a
 *     module gating on subscription status must be able to refuse it.
 *
 * Returns null when no module provides the hook (OSS mode allows everything).
 */
export async function checkUsageAllowed(args: {
  orgId: string;
  presetId: string;
  sessionId: string | null;
  subscription: boolean;
}): Promise<UsageRejection | null> {
  if (!hasHook("beforeUsage")) return null;
  // Fail-closed on a caller that omits `subscription` — the flag became
  // REQUIRED in @appstrate/core 6.0.0, and only an out-of-tree module built
  // against an older core can reach here without it (in-tree callers are
  // typechecked). Denying the turn beats defaulting: a missing flag would fall
  // through as `false`, reading a subscription turn as platform-funded — silent
  // mispricing with no error and no log. A thrown turn is visible and
  // recoverable; a mispriced one is neither.
  //
  // BELOW the early return, not above it: the guard exists to stop a fabricated
  // fact from reaching an admission hook, so it only has to fire when there IS
  // a hook. In OSS mode nothing prices a turn, and a stale caller must keep
  // getting the `null` it always got.
  if (typeof args.subscription !== "boolean") {
    throw new Error(
      "checkUsageAllowed: `subscription` is required (boolean) — caller built against @appstrate/core < 6.0.0",
    );
  }
  const rejection = await callHook("beforeUsage", {
    orgId: args.orgId,
    context: "chat",
    sessionId: args.sessionId,
    // A chat turn resolves its model on the platform before admission, so the
    // credential source is always determinable here (never `null`, unlike a
    // remote-origin run).
    credentialSource: args.subscription || !isSystemModel(args.presetId) ? "org" : "system",
    // A turn executes in the platform's own process — never on a
    // caller-supplied host. True of the in-process subscription engine too.
    executionPlane: "platform",
  });
  return rejection ?? null;
}
