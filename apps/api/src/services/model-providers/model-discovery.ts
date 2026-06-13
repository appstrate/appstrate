// SPDX-License-Identifier: Apache-2.0

/**
 * Empirical model discovery — probe which models a credential ACTUALLY
 * serves, instead of trusting a static list.
 *
 * Why probing: for subscription-backed OAuth providers (codex,
 * claude-code) the served model set depends on the *account's plan*
 * (ChatGPT Plus vs Pro, Claude Pro vs Max) and moves over time, with no
 * `/models` discovery endpoint (codex) and no machine-readable source.
 * A 1-token inference request per candidate is the only ground truth.
 *
 * Candidates come from the provider definition's
 * `modelDiscoveryCandidates` (falling back to `featuredModels`) —
 * modules own their candidate sets; the platform stays
 * provider-agnostic and just sends whatever `testModelConfig` builds
 * (module `buildInferenceProbe` hook or generic wire format).
 *
 * Classification per probe:
 *   - 2xx                → served, goes into `availableModelIds`
 *   - 401/403            → credential-level failure: ABORT the whole
 *                          discovery, never persist (an auth outage must
 *                          not shrink a previously-good list to [])
 *   - 429                → retried once after a pause; still 429 →
 *                          excluded this round (quota noise ≠ absence)
 *   - anything else      → not served
 *
 * The verified list persists on the credential row
 * (`available_model_ids`, `models_verified_at`). NULL = never probed —
 * readers fall back to the provider's static `featuredModels`. A run
 * where nothing verified does not persist either: an all-failure round
 * is indistinguishable from a network incident.
 */

import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials } from "@appstrate/db/schema";
import type { TestResult } from "@appstrate/shared-types";
import { loadInferenceCredentials } from "./credentials.ts";
import { getModelProvider } from "./registry.ts";
import { testModelConfig } from "../org-models.ts";
import { logger } from "../../lib/logger.ts";

/** Pause between probes — be a polite client of the user's quota. */
const INTER_PROBE_DELAY_MS = 250;
/** Pause before the single 429 retry. */
const RATE_LIMIT_RETRY_DELAY_MS = 2_000;
/** Hard cap — a runaway candidate list must not burn the user's quota. */
const MAX_CANDIDATES = 24;

export interface ModelDiscoveryResult {
  /** Outcome of the run. `persisted` only on `ok`. */
  outcome: "ok" | "auth_failed" | "nothing_verified" | "no_candidates" | "credential_not_found";
  /** Ids that answered 2xx, in candidate order. Empty unless `ok`. */
  verifiedModelIds: string[];
  /** Candidates probed (after dedupe + cap). */
  probedCount: number;
  /** True when the verified list was written to the credential row. */
  persisted: boolean;
}

export interface ModelDiscoveryDeps {
  /** Probe one (credential, modelId) — defaults to {@link testModelConfig}. */
  probe: (config: {
    apiShape: string;
    baseUrl: string;
    modelId: string;
    apiKey: string;
    providerId?: string;
    accountId?: string;
  }) => Promise<TestResult>;
  /** Sleep — injectable so unit tests don't wait. */
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: ModelDiscoveryDeps = {
  probe: testModelConfig,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Probe every discovery candidate of `credentialId` and persist the ids
 * that answered. Sequential on purpose — N concurrent 1-token requests
 * against a subscription backend is exactly the burst pattern that
 * trips rate limits and pollutes the result with 429s.
 */
export async function discoverAvailableModels(
  orgId: string,
  credentialId: string,
  deps: ModelDiscoveryDeps = defaultDeps,
): Promise<ModelDiscoveryResult> {
  const creds = await loadInferenceCredentials(orgId, credentialId);
  if (!creds) {
    return {
      outcome: "credential_not_found",
      verifiedModelIds: [],
      probedCount: 0,
      persisted: false,
    };
  }
  const def = getModelProvider(creds.providerId);
  const candidates = [...new Set(def?.modelDiscoveryCandidates ?? def?.featuredModels ?? [])].slice(
    0,
    MAX_CANDIDATES,
  );
  if (candidates.length === 0) {
    return { outcome: "no_candidates", verifiedModelIds: [], probedCount: 0, persisted: false };
  }

  const verified: string[] = [];
  for (const [i, modelId] of candidates.entries()) {
    if (i > 0) await deps.sleep(INTER_PROBE_DELAY_MS);
    let result = await deps.probe({ ...creds, modelId });
    if (!result.ok && result.status === 429) {
      await deps.sleep(RATE_LIMIT_RETRY_DELAY_MS);
      result = await deps.probe({ ...creds, modelId });
    }
    if (result.ok) {
      verified.push(modelId);
      continue;
    }
    if (result.error === "AUTH_FAILED") {
      logger.warn("model discovery aborted — credential auth failed", {
        credentialId,
        providerId: creds.providerId,
        modelId,
      });
      return {
        outcome: "auth_failed",
        verifiedModelIds: [],
        probedCount: i + 1,
        persisted: false,
      };
    }
    // 404 / model-not-found 400s / lingering 429 → not served this round.
  }

  if (verified.length === 0) {
    logger.warn("model discovery verified nothing — keeping previous list", {
      credentialId,
      providerId: creds.providerId,
      probedCount: candidates.length,
    });
    return {
      outcome: "nothing_verified",
      verifiedModelIds: [],
      probedCount: candidates.length,
      persisted: false,
    };
  }

  await db
    .update(modelProviderCredentials)
    .set({ availableModelIds: verified, modelsVerifiedAt: new Date(), updatedAt: new Date() })
    .where(
      and(eq(modelProviderCredentials.id, credentialId), eq(modelProviderCredentials.orgId, orgId)),
    );

  logger.info("model discovery persisted", {
    credentialId,
    providerId: creds.providerId,
    verifiedCount: verified.length,
    probedCount: candidates.length,
  });
  return {
    outcome: "ok",
    verifiedModelIds: verified,
    probedCount: candidates.length,
    persisted: true,
  };
}
