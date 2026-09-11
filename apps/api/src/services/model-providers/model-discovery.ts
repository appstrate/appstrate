// SPDX-License-Identifier: Apache-2.0

/**
 * Model discovery — which models a credential serves. Two strategies, by the
 * definition's `modelDiscovery`:
 *
 *   - `{ mode: "static" }` (subscription providers): ZERO API calls, nothing
 *     written (`docs/architecture/SUBSCRIPTION_COMPLIANCE.md`). The served set
 *     is a pure function of (definition, catalog), resolved on read by
 *     `resolveCredentialModelIds`; discovery reports the current list.
 *   - listing (API-key providers): ONE `GET <baseUrl>/models`
 *     (`listServedModels`), intersected with the discovery candidates and
 *     persisted as `available_model_ids` — the seed gate's authorization
 *     record, read only through `resolveCredentialModelIds`. AUTH_FAILED never
 *     persists; RATE_LIMITED is retried once; any other failure, a truncated
 *     listing, or an empty intersection, leaves the previous list standing.
 */

import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials } from "@appstrate/db/schema";
import { loadInferenceCredentials } from "./credentials.ts";
import { getModelProvider } from "./registry.ts";
import { resolveCatalogBackedCandidates, resolveDiscoveryCandidates } from "./model-selection.ts";
import { listServedModels, type ListServedModelsResult } from "./model-listing.ts";
import { logger } from "../../lib/logger.ts";

/** Pause before the single 429 retry. */
const RATE_LIMIT_RETRY_DELAY_MS = 2_000;
/** Hard cap — a runaway candidate list must not become an unbounded row. */
const MAX_CANDIDATES = 24;

/** The verified ids are not echoed: the caller re-reads them through the credential DTO. */
interface ModelDiscoveryResult {
  outcome: "ok" | "auth_failed" | "nothing_verified" | "no_candidates" | "credential_not_found";
  /** Candidates declared after dedupe and cap, on both paths. Not a request count, not a served count. */
  candidateCount: number;
}

export interface ModelDiscoveryDeps {
  /** List what a credential serves — defaults to {@link listServedModels}. */
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
  listModels: listServedModels,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

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

  if (def?.modelDiscovery?.mode === "static") {
    const served = resolveCatalogBackedCandidates(def);
    return {
      outcome: served.length > 0 ? "ok" : "no_candidates",
      candidateCount: resolveDiscoveryCandidates(def).slice(0, MAX_CANDIDATES).length,
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
    logger.warn("model discovery could not list served models — keeping previous list", {
      credentialId,
      providerId: creds.providerId,
      error: listing.error,
      status: listing.status,
      message: listing.message,
    });
    return { outcome: "nothing_verified", candidateCount: candidates.length };
  }

  // A short listing is a partial view of what the endpoint serves, so
  // intersecting against it would drop candidates that sit past the cap — the
  // same reason the failure branches above keep the previous list.
  if (listing.truncated) {
    logger.warn("model discovery read a truncated listing — keeping previous list", {
      credentialId,
      providerId: creds.providerId,
      candidateCount: candidates.length,
      servedCount: listing.models.length,
    });
    return { outcome: "nothing_verified", candidateCount: candidates.length };
  }

  // Declaration order: the candidate list is the provider's own ranking.
  const served = new Set(listing.models.map((m) => m.id));
  const verified = candidates.filter((id) => served.has(id));

  if (verified.length === 0) {
    logger.warn("model discovery verified nothing — keeping previous list", {
      credentialId,
      providerId: creds.providerId,
      candidateCount: candidates.length,
      servedCount: listing.models.length,
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
