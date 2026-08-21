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
 *     Because no probe ever runs, the served set is a pure function of
 *     (definition, catalog) — identical for every credential of the provider
 *     — so it is resolved on read by `resolveCredentialModelIds` instead of
 *     being copied into `available_model_ids`, where it could only rot.
 *     Discovery is then a truthful no-op: it reports the current list.
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
 * That column is written by the probe path ONLY — read it through
 * `resolveCredentialModelIds`, never directly.
 */

import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials } from "@appstrate/db/schema";
import type { TestResult } from "@appstrate/shared-types";
import { loadInferenceCredentials } from "./credentials.ts";
import { getModelProvider } from "./registry.ts";
import { resolveCatalogBackedCandidates, resolveDiscoveryCandidates } from "./model-selection.ts";
import { testModelConfig } from "../org-models.ts";
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

/**
 * What a discovery run reports back. Deliberately narrow: the verified ids are
 * NOT echoed here, because the row (probe path) or the definition+catalog
 * (`mode: "static"`) is the single place they are read from — see
 * `resolveCredentialModelIds`. The caller re-reads through the credential DTO,
 * so a round that verified nothing answers with the list that still stands
 * rather than an empty array that never was one.
 */
export interface ModelDiscoveryResult {
  outcome: "ok" | "auth_failed" | "nothing_verified" | "no_candidates" | "credential_not_found";
  /**
   * Candidates probed (after dedupe + cap). Always 0 for `mode: "static"`
   * providers — they consider candidates without any upstream request.
   */
  probedCount: number;
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
 * Persist the probe-verified ids onto the credential and return the standard
 * `ok` result. Probe path only — `mode: "static"` providers never reach here.
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
  return { outcome: "ok", probedCount };
}

/**
 * Probe every discovery candidate of `credentialId` and persist the ids
 * that answered. The first candidate runs alone as an auth gate (a dead
 * credential aborts after one probe); the rest fan out at
 * {@link PROBE_CONCURRENCY}. Bounded concurrency — not an unlimited
 * burst — keeps it polite to the subscription backend's rate limits
 * while cutting wall-clock from O(n) sequential round-trips to ~O(n/4).
 *
 * `mode: "static"` providers skip probing entirely and write nothing — see
 * the module header.
 */
export async function discoverAvailableModels(
  orgId: string,
  credentialId: string,
  deps: ModelDiscoveryDeps = defaultDeps,
): Promise<ModelDiscoveryResult> {
  const creds = await loadInferenceCredentials(orgId, credentialId);
  if (!creds) {
    return { outcome: "credential_not_found", probedCount: 0 };
  }
  const def = getModelProvider(creds.providerId);

  // Static-discovery providers (subscription: codex, claude-code) — resolve
  // the served list and write NOTHING. No network probe (the platform never
  // spends a subscription request to enumerate models; real per-model
  // availability is validated at the first agent run on the Pi engine) and no
  // row update either: the result is the same pure function of (definition,
  // catalog) that every read path already evaluates, so persisting it would
  // create a second copy whose only distinguishing property is being older.
  // `probedCount: 0` — zero upstream requests were spent. The endpoint stays
  // a valid no-op rather than a lie or a 404: callers (the model form) get
  // the current list back exactly as before.
  if (def?.modelDiscovery?.mode === "static") {
    const served = resolveCatalogBackedCandidates(def);
    return {
      // `no_candidates` on empty, same meaning as on the probe path: the
      // provider resolved no candidate at all. Nothing is at stake in the
      // distinction any more (there is no previous list to protect), but the
      // outcome should stay honest about an empty answer.
      outcome: served.length > 0 ? "ok" : "no_candidates",
      probedCount: 0,
    };
  }

  const candidates = (def ? resolveDiscoveryCandidates(def) : []).slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) {
    return { outcome: "no_candidates", probedCount: 0 };
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
    return { outcome: "auth_failed", probedCount };
  }

  // Preserve candidate (declaration) order regardless of completion order.
  const verified = candidates.filter((id) => verifiedSet.has(id));

  if (verified.length === 0) {
    logger.warn("model discovery verified nothing — keeping previous list", {
      credentialId,
      providerId: creds.providerId,
      probedCount: candidates.length,
    });
    return { outcome: "nothing_verified", probedCount: candidates.length };
  }

  logger.info("model discovery persisted", {
    credentialId,
    providerId: creds.providerId,
    verifiedCount: verified.length,
    probedCount: candidates.length,
  });
  return persistVerifiedModels(orgId, credentialId, verified, candidates.length);
}
