// SPDX-License-Identifier: Apache-2.0

/**
 * Model discovery — determine which models a credential serves and persist
 * them on the credential row (`available_model_ids`).
 *
 * Two strategies, chosen by the provider definition's `modelDiscovery` field:
 *
 *   - `{ mode: "static" }` (subscription providers: codex, claude-code) — the
 *     platform issues ZERO API calls. It persists the provider's static
 *     `modelDiscoveryCandidates` (∩ catalog) directly. Spending a user's
 *     subscription quota to enumerate models would contradict the
 *     compliance posture (`docs/architecture/SUBSCRIPTION_COMPLIANCE.md`):
 *     all subscription inference runs through the Pi engine (pi-ai emits
 *     the provider's request shape) at run time, never a platform-side
 *     request. Real per-model availability is validated at first run.
 *
 *   - probe (default, when `modelDiscovery` is omitted — API-key providers) —
 *     empirical: a 1-token inference request per candidate, persisting the ids
 *     that answered 2xx. Candidates come from `modelDiscoveryCandidates`
 *     (falling back to `featuredModels`); the platform stays provider-agnostic
 *     and just sends whatever `testModelConfig` builds (generic `/models` wire
 *     format).
 *
 * The classification below applies only to the probe path:
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
 * The verified list persists on the credential row (`available_model_ids`)
 * as the server-side authorization record for model seeding
 * (`routes/models.ts` gates a model-add against it). A run where nothing
 * verified does not persist either: an all-failure round is
 * indistinguishable from a network incident, so the previous list stands.
 */

import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials } from "@appstrate/db/schema";
import type { TestResult } from "@appstrate/shared-types";
import { loadInferenceCredentials } from "./credentials.ts";
import { getModelProvider } from "./registry.ts";
import { testModelConfig } from "../org-models.ts";
import { listCatalogModels } from "../pricing-catalog.ts";
import { logger } from "../../lib/logger.ts";

/** Pause before the single 429 retry. */
const RATE_LIMIT_RETRY_DELAY_MS = 2_000;
/** Hard cap — a runaway candidate list must not burn the user's quota. */
const MAX_CANDIDATES = 24;
/**
 * Max concurrent probes. Bounded fan-out is the politeness limiter (it
 * replaces the old per-probe sleep): a handful in flight is fast without
 * being the burst pattern that trips subscription-backend rate limits.
 */
const PROBE_CONCURRENCY = 4;

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
 * Persist the static `modelDiscoveryCandidates` (∩ resolved catalog) for a
 * `{ mode: "static" }` provider, with NO network call. Used for subscription
 * providers whose tokens must never be spent on a platform-side probe. The
 * catalog intersection mirrors the `/seed` route's gate (catalog membership),
 * so the persisted list is exactly the set a user can actually seed. An empty
 * candidate list is a no-op that leaves any previous list untouched.
 */
/**
 * Persist the verified ids onto the credential and return the standard `ok`
 * result. Shared by both discovery paths (static candidate intersection and
 * network probe) — the org-scoped UPDATE and the result shape are identical;
 * only the surrounding log line differs, so each caller logs its own.
 */
async function persistVerifiedModels(
  orgId: string,
  credentialId: string,
  verified: string[],
  probedCount: number,
): Promise<ModelDiscoveryResult> {
  await db
    .update(modelProviderCredentials)
    .set({ availableModelIds: verified, updatedAt: new Date() })
    .where(
      and(eq(modelProviderCredentials.id, credentialId), eq(modelProviderCredentials.orgId, orgId)),
    );
  return { outcome: "ok", verifiedModelIds: verified, probedCount, persisted: true };
}

async function persistStaticCandidates(
  orgId: string,
  credentialId: string,
  providerId: string,
  def: NonNullable<ReturnType<typeof getModelProvider>>,
): Promise<ModelDiscoveryResult> {
  const catalogKey = def.catalogProviderId ?? providerId;
  const catalogIds = new Set(listCatalogModels(catalogKey).map((m) => m.id));
  const candidates = [...new Set(def.modelDiscoveryCandidates ?? def.featuredModels ?? [])];
  const verified = candidates.filter((id) => catalogIds.has(id));

  if (verified.length === 0) {
    logger.warn("static model discovery resolved no catalog-backed candidates — keeping list", {
      credentialId,
      providerId,
      candidateCount: candidates.length,
    });
    return {
      outcome: "nothing_verified",
      verifiedModelIds: [],
      probedCount: candidates.length,
      persisted: false,
    };
  }

  logger.info("static model discovery persisted catalog-backed candidates", {
    credentialId,
    providerId,
    verifiedCount: verified.length,
    candidateCount: candidates.length,
  });
  return persistVerifiedModels(orgId, credentialId, verified, candidates.length);
}

/**
 * Probe every discovery candidate of `credentialId` and persist the ids
 * that answered. The first candidate runs alone as an auth gate (a dead
 * credential aborts after one probe); the rest fan out at
 * {@link PROBE_CONCURRENCY}. Bounded concurrency — not an unlimited
 * burst — keeps it polite to the subscription backend's rate limits
 * while cutting wall-clock from O(n) sequential round-trips to ~O(n/4).
 *
 * `mode: "static"` providers skip probing entirely — see
 * {@link persistStaticCandidates}.
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

  // Static-discovery providers (subscription: codex, claude-code) — persist the
  // static candidate list (∩ catalog) WITHOUT any network probe. The
  // platform never spends a subscription request to enumerate models; real
  // per-model availability is validated at the first agent run (Pi engine). The
  // catalog intersection keeps `available_model_ids` aligned with what the
  // `/seed` route can actually accept (it gates seeding on catalog
  // membership), so a candidate absent from the catalog isn't persisted as
  // "available" only to be rejected at seed time.
  if (def?.modelDiscovery?.mode === "static") {
    return persistStaticCandidates(orgId, credentialId, creds.providerId, def);
  }

  const candidates = [...new Set(def?.modelDiscoveryCandidates ?? def?.featuredModels ?? [])].slice(
    0,
    MAX_CANDIDATES,
  );
  if (candidates.length === 0) {
    return { outcome: "no_candidates", verifiedModelIds: [], probedCount: 0, persisted: false };
  }

  // Probe one candidate (with the single 429 retry). Returns "auth" on a
  // credential-level failure so callers can abort the whole run.
  const verifiedSet = new Set<string>();
  let probedCount = 0;
  const runProbe = async (modelId: string): Promise<"auth" | void> => {
    probedCount++;
    let result = await deps.probe({ ...creds, modelId });
    if (!result.ok && result.status === 429) {
      await deps.sleep(RATE_LIMIT_RETRY_DELAY_MS);
      result = await deps.probe({ ...creds, modelId });
    }
    if (result.ok) {
      verifiedSet.add(modelId);
      return;
    }
    if (result.error === "AUTH_FAILED") return "auth";
    // 404 / model-not-found 400s / lingering 429 → not served this round.
  };

  // Sequential auth gate on the first candidate: a dead credential aborts
  // before any fan-out, so an auth outage burns exactly one probe (and
  // never wipes a previously-good list). The rest run bounded-parallel.
  const [firstCandidate, ...rest] = candidates;
  let authFailed = (await runProbe(firstCandidate!)) === "auth";

  if (!authFailed && rest.length > 0) {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!authFailed) {
        const i = next++;
        if (i >= rest.length) return;
        if ((await runProbe(rest[i]!)) === "auth") authFailed = true;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PROBE_CONCURRENCY, rest.length) }, () => worker()),
    );
  }

  if (authFailed) {
    logger.warn("model discovery aborted — credential auth failed", {
      credentialId,
      providerId: creds.providerId,
    });
    return { outcome: "auth_failed", verifiedModelIds: [], probedCount, persisted: false };
  }

  // Preserve candidate (declaration) order regardless of completion order.
  const verified = candidates.filter((id) => verifiedSet.has(id));

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

  logger.info("model discovery persisted", {
    credentialId,
    providerId: creds.providerId,
    verifiedCount: verified.length,
    probedCount: candidates.length,
  });
  return persistVerifiedModels(orgId, credentialId, verified, candidates.length);
}
