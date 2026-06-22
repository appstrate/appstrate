// SPDX-License-Identifier: Apache-2.0

/**
 * Shared subscription-credential resolution for the two SDK subscription
 * surfaces — the Claude Code reverse-proxy gateway and the Codex credential
 * vend. Both run the identical policy before they diverge (Claude forwards the
 * call; Codex hands the token back):
 *
 *   1. `loadModel(org, preset)` → a pre-flagged `needsReconnection` credential
 *      resolves to `null`; surface the actionable reconnect prompt instead of a
 *      misleading "not enabled" 400.
 *   2. The preset MUST belong to the expected subscription provider (this path
 *      injects an OAuth subscription token — only that provider may receive it).
 *   3. The preset MUST carry an OAuth credential id to resolve.
 *   4. Resolve a fresh token (auto-refresh, Redis-deduped). A refresh-time
 *      revocation throws `gone()` (410) → translate it into the provider-native
 *      auth-error envelope the engine surfaces as "reconnect your subscription".
 *
 * Returns the resolved model + token on success, or a ready-to-return error
 * `Response` for the two reconnect paths. Any other failure throws (an
 * unexpected error must not masquerade as an auth problem). Each caller passes
 * its own provider-native error builders — those envelopes genuinely differ
 * (Anthropic vs Codex JSON shape + FR message) and stay caller-owned.
 */

import { loadModel, modelNeedsReconnection, type ResolvedModel } from "../org-models.ts";
import { resolveOAuthTokenForSidecar } from "../model-providers/token-resolver.ts";
import { ApiError, invalidRequest } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";

/**
 * Build a `translateAuthError` for {@link resolveSubscriptionToken}: a
 * token-refresh failure that surfaced as `gone()` (410 — the credential was
 * revoked/expired upstream) becomes the provider-native auth-error `Response`
 * the engine renders as "reconnect your subscription"; any other error returns
 * `null` so the caller rethrows it unchanged (an unexpected failure must not
 * masquerade as an auth problem). Both subscription surfaces share this 410→401
 * logic; only the envelope shape (passed as `builder`) differs. Pure for tests.
 */
export function make410AuthTranslator(builder: () => Response): (err: unknown) => Response | null {
  return (err: unknown): Response | null => {
    if (!(err instanceof ApiError) || err.status !== 410) return null;
    return builder();
  };
}

export interface ResolvedSubscription {
  resolved: ResolvedModel;
  token: Awaited<ReturnType<typeof resolveOAuthTokenForSidecar>>;
}

export interface ResolveSubscriptionTokenOptions {
  orgId: string;
  presetId: string;
  /** Provider id the preset must belong to (e.g. `"claude-code"`, `"codex"`). */
  expectedProviderId: string;
  /** Human-readable provider name for the mismatch message (e.g. `"Claude Code"`). */
  providerLabel: string;
  /** Provider-native 401 for the pre-flagged `needsReconnection` path. */
  authErrorResponse: () => Response;
  /** Translate a token-resolution failure → 401 on a 410, else `null` (rethrow). */
  translateAuthError: (err: unknown) => Response | null;
  /** Log-line prefix identifying the calling surface. */
  logLabel: string;
}

export async function resolveSubscriptionToken(
  opts: ResolveSubscriptionTokenOptions,
): Promise<ResolvedSubscription | Response> {
  const { orgId, presetId, expectedProviderId, providerLabel } = opts;

  const resolved = await loadModel(orgId, presetId);
  if (!resolved) {
    if (await modelNeedsReconnection(orgId, presetId)) {
      logger.warn(`${opts.logLabel}: subscription needs reconnection (pre-flagged)`, { presetId });
      return opts.authErrorResponse();
    }
    throw invalidRequest(`Model preset "${presetId}" is not enabled for this org`);
  }
  if (resolved.providerId !== expectedProviderId) {
    throw invalidRequest(
      `Model preset "${presetId}" is not a ${providerLabel} subscription model (provider: ${resolved.providerId})`,
    );
  }
  if (!resolved.credentialId) {
    throw invalidRequest(`Model preset "${presetId}" has no OAuth credential to resolve`);
  }

  let token: Awaited<ReturnType<typeof resolveOAuthTokenForSidecar>>;
  try {
    token = await resolveOAuthTokenForSidecar(resolved.credentialId, orgId);
  } catch (err) {
    const authError = opts.translateAuthError(err);
    if (authError) {
      logger.warn(`${opts.logLabel}: subscription needs reconnection`, { presetId });
      return authError;
    }
    throw err;
  }

  return { resolved, token };
}
