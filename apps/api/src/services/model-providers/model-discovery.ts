// SPDX-License-Identifier: Apache-2.0

/**
 * Model discovery — determine which models a credential serves.
 *
 * Two strategies, chosen by the provider definition's `modelDiscovery` field:
 *
 *   - `{ mode: "static" }` (subscription providers: codex, claude-code) — the
 *     platform issues ZERO API calls AND writes nothing. Spending a user's
 *     subscription quota to enumerate models would contradict the
 *     compliance posture (`docs/architecture/SUBSCRIPTION_COMPLIANCE.md`):
 *     all subscription inference runs through the Pi engine (pi-ai emits
 *     the provider's request shape) at run time, never a platform-side
 *     request. Real per-model availability is validated at first run.
 *     Because no listing ever runs, the served set is a pure function of
 *     (definition, catalog) — identical for every credential of the provider
 *     — so it is resolved on read by `resolveCredentialModelIds` instead of
 *     being copied into `available_model_ids`, where it could only rot.
 *     Discovery is then a truthful no-op: it reports the current list.
 *
 *   - listing (default, when `modelDiscovery` is omitted — API-key providers)
 *     — ONE `GET <baseUrl>/models` request (`listServedModelIds`,
 *     `model-listing.ts`), whose parsed body is intersected with the
 *     provider's discovery candidates (`modelDiscoveryCandidates`, falling
 *     back to `featuredModels`). A candidate the provider does not list is
 *     not persisted, and the request count does not grow with the candidate
 *     list — the listing identifies both the credential and what it serves.
 *
 * The classification below applies only to the listing path:
 *   - 2xx with a parseable body → intersect, persist the intersection
 *   - AUTH_FAILED (401/403)     → credential-level failure: never persist (an
 *                                 auth outage must not shrink a
 *                                 previously-good list to [])
 *   - RATE_LIMITED (429)        → retried once after a pause; still limited →
 *                                 previous list stands (quota noise ≠ absence)
 *   - UNREACHABLE / BLOCKED_URL / HTTP_ERROR / BAD_RESPONSE → previous list
 *                                 stands
 *
 * The verified list persists on the credential row (`available_model_ids`)
 * as the server-side authorization record for model seeding
 * (`routes/models.ts` gates a model-add against it). A run where nothing
 * intersected does not persist either: an empty intersection is
 * indistinguishable from a listing served by a misconfigured endpoint, so the
 * previous list stands. That column is written by the listing path ONLY —
 * read it through `resolveCredentialModelIds`, never directly.
 */

import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials } from "@appstrate/db/schema";
import { loadInferenceCredentials } from "./credentials.ts";
import { getModelProvider } from "./registry.ts";
import { resolveCatalogBackedCandidates, resolveDiscoveryCandidates } from "./model-selection.ts";
import { listServedModelIds, type ListServedModelsResult } from "./model-listing.ts";
import { logger } from "../../lib/logger.ts";

/** Pause before the single 429 retry. */
const RATE_LIMIT_RETRY_DELAY_MS = 2_000;
/** Hard cap — a runaway candidate list must not become an unbounded row. */
const MAX_CANDIDATES = 24;

/**
 * What a discovery run reports back. Deliberately narrow: the verified ids are
 * NOT echoed here, because the row (listing path) or the definition+catalog
 * (`mode: "static"`) is the single place they are read from — see
 * `resolveCredentialModelIds`. The caller re-reads through the credential DTO,
 * so a round that verified nothing answers with the list that still stands
 * rather than an empty array that never was one.
 */
interface ModelDiscoveryResult {
  outcome: "ok" | "auth_failed" | "nothing_verified" | "no_candidates" | "credential_not_found";
  /**
   * Discovery candidates considered (after dedupe + cap), whatever the
   * outcome. NOT a request count: the listing path spends one request (two
   * when a 429 is retried) regardless, and `mode: "static"` providers spend
   * none.
   */
  candidateCount: number;
}

export interface ModelDiscoveryDeps {
  /** List what a credential serves — defaults to {@link listServedModelIds}. */
  listModels: (config: {
    apiShape: string;
    baseUrl: string;
    apiKey: string;
    providerId?: string;
  }) => Promise<ListServedModelsResult>;
  /** Sleep — injectable so unit tests don't wait. */
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: ModelDiscoveryDeps = {
  listModels: listServedModelIds,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Persist the verified ids onto the credential and return the standard `ok`
 * result. Listing path only — `mode: "static"` providers never reach here.
 */
async function persistVerifiedModels(
  orgId: string,
  credentialId: string,
  verified: string[],
  candidateCount: number,
): Promise<ModelDiscoveryResult> {
  await db
    .update(modelProviderCredentials)
    .set({ availableModelIds: verified, updatedAt: new Date() })
    .where(
      and(eq(modelProviderCredentials.id, credentialId), eq(modelProviderCredentials.orgId, orgId)),
    );
  return { outcome: "ok", candidateCount };
}

/**
 * List what `credentialId` serves and persist the discovery candidates that
 * appear in that listing, in declaration order.
 *
 * `mode: "static"` providers list nothing and write nothing — see the module
 * header.
 */
export async function discoverAvailableModels(
  orgId: string,
  credentialId: string,
  deps: ModelDiscoveryDeps = defaultDeps,
): Promise<ModelDiscoveryResult> {
  const creds = await loadInferenceCredentials(orgId, credentialId);
  if (!creds) {
    return { outcome: "credential_not_found", candidateCount: 0 };
  }
  const def = getModelProvider(creds.providerId);

  // Static-discovery providers (subscription: codex, claude-code) — resolve
  // the served list and write NOTHING. No network request (the platform never
  // spends a subscription request to enumerate models; real per-model
  // availability is validated at the first agent run on the Pi engine) and no
  // row update either: the result is the same pure function of (definition,
  // catalog) that every read path already evaluates, so persisting it would
  // create a second copy whose only distinguishing property is being older.
  // The endpoint stays a valid no-op rather than a lie or a 404: callers (the
  // model form) get the current list back exactly as before.
  if (def?.modelDiscovery?.mode === "static") {
    const served = resolveCatalogBackedCandidates(def);
    return {
      // `no_candidates` on empty, same meaning as on the listing path: the
      // provider resolved no candidate at all. Nothing is at stake in the
      // distinction any more (there is no previous list to protect), but the
      // outcome should stay honest about an empty answer.
      outcome: served.length > 0 ? "ok" : "no_candidates",
      candidateCount: served.length,
    };
  }

  const candidates = (def ? resolveDiscoveryCandidates(def) : []).slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) {
    return { outcome: "no_candidates", candidateCount: 0 };
  }

  let listing = await deps.listModels(creds);
  if (!listing.ok && listing.error === "RATE_LIMITED") {
    await deps.sleep(RATE_LIMIT_RETRY_DELAY_MS);
    listing = await deps.listModels(creds);
  }

  if (!listing.ok) {
    if (listing.error === "AUTH_FAILED") {
      logger.warn("model discovery aborted — credential auth failed", {
        credentialId,
        providerId: creds.providerId,
      });
      return { outcome: "auth_failed", candidateCount: candidates.length };
    }
    // Unreachable, refused URL, non-2xx, unparseable body, or still rate
    // limited after the retry — none of them says the credential serves nothing.
    logger.warn("model discovery could not list served models — keeping previous list", {
      credentialId,
      providerId: creds.providerId,
      error: listing.error,
      status: listing.status,
      message: listing.message,
    });
    return { outcome: "nothing_verified", candidateCount: candidates.length };
  }

  // Declaration order, not response order: the candidate list is the
  // provider's own ranking and the model picker renders it as such.
  const served = new Set(listing.modelIds);
  const verified = candidates.filter((id) => served.has(id));

  if (verified.length === 0) {
    logger.warn("model discovery verified nothing — keeping previous list", {
      credentialId,
      providerId: creds.providerId,
      candidateCount: candidates.length,
      servedCount: listing.modelIds.length,
    });
    return { outcome: "nothing_verified", candidateCount: candidates.length };
  }

  logger.info("model discovery persisted", {
    credentialId,
    providerId: creds.providerId,
    verifiedCount: verified.length,
    candidateCount: candidates.length,
  });
  return persistVerifiedModels(orgId, credentialId, verified, candidates.length);
}
