// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `discoverAvailableModels` — empirical model
 * discovery against a credential, with the model listing injected so no
 * network leaves the process.
 *
 * Uses a synthetic `test-listing-discovery` provider (registered here,
 * baseline restored in `afterAll`) so the zero-footprint invariant
 * holds — no module knowledge in core tests.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedOrgModelProviderKey, seedOrgModelProviderOAuth } from "../../helpers/seed.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import { registerModelProvider } from "../../../src/services/model-providers/registry.ts";
import { registerCatalog } from "../../../src/services/pricing-catalog.ts";
import {
  discoverAvailableModels,
  type ModelDiscoveryDeps,
} from "../../../src/services/model-providers/model-discovery.ts";
import { getOrgModelProviderCredential } from "../../../src/services/model-providers/credentials.ts";
import type { ListServedModelsResult } from "../../../src/services/model-providers/model-listing.ts";

const PROVIDER_ID = "test-listing-discovery";
const OFFLINE_PROVIDER_ID = "test-offline-discovery";

/**
 * Synthetic provider declaring `modelDiscovery: { mode: "static" }` — exercises
 * the no-network discovery path (subscription providers codex/claude-code).
 * Reuses the same catalog as the listing provider. Candidate "m-uncatalogued"
 * is intentionally absent from the catalog to pin the ∩-catalog filter.
 */
function registerOfflineDiscoveryProvider(): void {
  registerModelProvider({
    providerId: OFFLINE_PROVIDER_ID,
    displayName: "Test Offline Discovery",
    iconUrl: "anthropic",
    description: "Synthetic offline-validation provider.",
    apiShape: "anthropic-messages",
    defaultBaseUrl: "https://offline.example.test",
    baseUrlOverridable: false,
    authMode: "oauth2",
    oauth: {
      clientId: "test-offline-client",
      authorizationUrl: "https://auth.example.test/authorize",
      tokenUrl: "https://auth.example.test/token",
      refreshUrl: "https://auth.example.test/token",
      scopes: ["openid"],
      pkce: "S256",
    },
    catalogProviderId: "test-discovery-catalog",
    featuredModels: ["m-featured"],
    modelDiscoveryCandidates: ["m-featured", "m-extra", "m-uncatalogued"],
    modelDiscovery: { mode: "static" },
  });
}

function registerDiscoveryProvider(): void {
  // Catalog first — registerModelProvider validates featured ids against it.
  registerCatalog("test-discovery-catalog", {
    "m-featured": {
      label: "Featured",
      contextWindow: 8192,
      maxTokens: 1024,
      capabilities: ["text"],
      cost: { input: 0, output: 0 },
    },
    "m-extra": {
      label: "Extra",
      contextWindow: 8192,
      maxTokens: 1024,
      capabilities: ["text"],
      cost: { input: 0, output: 0 },
    },
  });
  registerModelProvider({
    providerId: PROVIDER_ID,
    displayName: "Test Listing Discovery",
    iconUrl: "openai",
    description: "Synthetic provider exercising model discovery.",
    apiShape: "openai-responses",
    defaultBaseUrl: "https://discovery.example.test/v1",
    baseUrlOverridable: false,
    // API-key: the listing path is the only one an oauth2 provider may not
    // take — `registerModelProvider` refuses one that is not `mode: "static"`.
    authMode: "api_key",
    catalogProviderId: "test-discovery-catalog",
    featuredModels: ["m-featured"],
    modelDiscoveryCandidates: ["m-featured", "m-extra", "m-gone"],
  });
}

/**
 * Listing stub answering from a scripted queue (the last entry repeats);
 * records how many listing requests discovery spent.
 */
function scriptedListing(results: ListServedModelsResult[]): {
  deps: ModelDiscoveryDeps;
  calls: () => number;
} {
  let calls = 0;
  const queue = [...results];
  return {
    calls: () => calls,
    deps: {
      sleep: async () => {},
      listModels: async () => {
        calls++;
        if (queue.length === 0) {
          return { ok: false, error: "UNREACHABLE", message: "no scripted listing" };
        }
        return queue.length === 1 ? queue[0]! : queue.shift()!;
      },
    },
  };
}

/** A listing stub that fails the test if discovery touches the network. */
function forbiddenListing(): { deps: ModelDiscoveryDeps; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    deps: {
      sleep: async () => {},
      listModels: async () => {
        calls++;
        throw new Error("static discovery must not list models upstream");
      },
    },
  };
}

const served = (...modelIds: string[]): ListServedModelsResult => ({
  ok: true,
  models: modelIds.map((id) => ({ id, hints: {} })),
  truncated: false,
});
/** The same listing, cut short by a cap: what is missing is unseen, not unserved. */
const servedTruncated = (...modelIds: string[]): ListServedModelsResult => ({
  ok: true,
  models: modelIds.map((id) => ({ id, hints: {} })),
  truncated: true,
});
const AUTH_FAILED: ListServedModelsResult = {
  ok: false,
  error: "AUTH_FAILED",
  status: 401,
  message: "Authentication failed",
};
const RATE_LIMITED: ListServedModelsResult = {
  ok: false,
  error: "RATE_LIMITED",
  status: 429,
  message: "Rate limited",
};
const UNREACHABLE: ListServedModelsResult = {
  ok: false,
  error: "UNREACHABLE",
  message: "Request timed out (10s)",
};

describe("discoverAvailableModels", () => {
  let ctx: TestContext;

  beforeAll(() => {
    registerDiscoveryProvider();
    registerOfflineDiscoveryProvider();
  });
  afterAll(() => {
    seedTestModelProviders();
  });
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    // seedTestModelProviders (called by other files) wipes the synthetic
    // provider — re-register defensively. registerModelProvider overwrites
    // are rejected, so guard via registry lookup is unnecessary: the
    // helper resets the registry wholesale, never partially.
    try {
      registerDiscoveryProvider();
      registerOfflineDiscoveryProvider();
    } catch {
      // already registered in this process — fine.
    }
  });

  it("persists the candidates the provider lists, in candidate order", async () => {
    const cred = await seedOrgModelProviderKey({ orgId: ctx.org.id, providerId: PROVIDER_ID });
    // Response order is deliberately the reverse of the declaration order, and
    // carries an id the provider declares no candidate for.
    const { deps, calls } = scriptedListing([served("m-unrelated", "m-extra", "m-featured")]);

    const result = await discoverAvailableModels(ctx.org.id, cred.id, deps);

    expect(result.outcome).toBe("ok");
    // One listing request for the whole candidate list.
    expect(calls()).toBe(1);
    const info = await getOrgModelProviderCredential(ctx.org.id, cred.id);
    expect(info?.available_model_ids).toEqual(["m-featured", "m-extra"]);
  });

  it("aborts without persisting on AUTH_FAILED (an auth outage must not wipe a good list)", async () => {
    const cred = await seedOrgModelProviderKey({ orgId: ctx.org.id, providerId: PROVIDER_ID });
    const { deps, calls } = scriptedListing([AUTH_FAILED]);

    const result = await discoverAvailableModels(ctx.org.id, cred.id, deps);

    expect(result.outcome).toBe("auth_failed");
    // A dead credential is not retried.
    expect(calls()).toBe(1);
    // Read the RAW column, not the DTO. The DTO resolves through
    // `resolveCredentialModelIds`, which coalesces a never-written column to
    // `[]` — so asserting `[]` there cannot tell "never wrote" from "wrote an
    // empty list", and a regression that WIPES a good list on `auth_failed`
    // would pass. The whole point of this test is that the failed round wrote
    // nothing, so it has to assert on the thing that would have been written.
    const [row] = await db
      .select({ ids: modelProviderCredentials.availableModelIds })
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, cred.id));
    expect(row?.ids).toBeNull();
  });

  it("keeps the previous list when the provider is unreachable", async () => {
    const cred = await seedOrgModelProviderKey({ orgId: ctx.org.id, providerId: PROVIDER_ID });
    await discoverAvailableModels(
      ctx.org.id,
      cred.id,
      scriptedListing([served("m-featured")]).deps,
    );

    const result = await discoverAvailableModels(
      ctx.org.id,
      cred.id,
      scriptedListing([UNREACHABLE]).deps,
    );

    expect(result.outcome).toBe("nothing_verified");
    const info = await getOrgModelProviderCredential(ctx.org.id, cred.id);
    expect(info?.available_model_ids).toEqual(["m-featured"]);
  });

  it("keeps the previous list when no candidate appears in the listing", async () => {
    const cred = await seedOrgModelProviderKey({ orgId: ctx.org.id, providerId: PROVIDER_ID });
    await discoverAvailableModels(
      ctx.org.id,
      cred.id,
      scriptedListing([served("m-featured")]).deps,
    );

    const result = await discoverAvailableModels(
      ctx.org.id,
      cred.id,
      scriptedListing([served("m-something-else")]).deps,
    );

    expect(result.outcome).toBe("nothing_verified");
    const info = await getOrgModelProviderCredential(ctx.org.id, cred.id);
    expect(info?.available_model_ids).toEqual(["m-featured"]);
  });

  it("keeps the previous list when a cap cut the listing short", async () => {
    const cred = await seedOrgModelProviderKey({ orgId: ctx.org.id, providerId: PROVIDER_ID });
    await discoverAvailableModels(
      ctx.org.id,
      cred.id,
      scriptedListing([served("m-featured", "m-extra")]).deps,
    );

    const result = await discoverAvailableModels(
      ctx.org.id,
      cred.id,
      scriptedListing([servedTruncated("m-featured")]).deps,
    );

    expect(result.outcome).toBe("nothing_verified");
    const info = await getOrgModelProviderCredential(ctx.org.id, cred.id);
    expect(info?.available_model_ids).toEqual(["m-featured", "m-extra"]);
  });

  it("drops a candidate the provider stopped serving when the listing is complete", async () => {
    const cred = await seedOrgModelProviderKey({ orgId: ctx.org.id, providerId: PROVIDER_ID });
    await discoverAvailableModels(
      ctx.org.id,
      cred.id,
      scriptedListing([served("m-featured", "m-extra")]).deps,
    );

    const result = await discoverAvailableModels(
      ctx.org.id,
      cred.id,
      scriptedListing([served("m-featured")]).deps,
    );

    expect(result.outcome).toBe("ok");
    const info = await getOrgModelProviderCredential(ctx.org.id, cred.id);
    expect(info?.available_model_ids).toEqual(["m-featured"]);
  });

  it("retries a 429 once and persists when the retry succeeds", async () => {
    const cred = await seedOrgModelProviderKey({ orgId: ctx.org.id, providerId: PROVIDER_ID });
    const { deps, calls } = scriptedListing([RATE_LIMITED, served("m-featured")]);

    const result = await discoverAvailableModels(ctx.org.id, cred.id, deps);

    expect(result.outcome).toBe("ok");
    expect(calls()).toBe(2);
    const info = await getOrgModelProviderCredential(ctx.org.id, cred.id);
    expect(info?.available_model_ids).toEqual(["m-featured"]);
  });

  it("keeps the previous list when the retry is rate limited too", async () => {
    const cred = await seedOrgModelProviderKey({ orgId: ctx.org.id, providerId: PROVIDER_ID });
    await discoverAvailableModels(
      ctx.org.id,
      cred.id,
      scriptedListing([served("m-featured")]).deps,
    );
    const { deps, calls } = scriptedListing([RATE_LIMITED]);

    const result = await discoverAvailableModels(ctx.org.id, cred.id, deps);

    expect(result.outcome).toBe("nothing_verified");
    // One retry, not a loop.
    expect(calls()).toBe(2);
    const info = await getOrgModelProviderCredential(ctx.org.id, cred.id);
    expect(info?.available_model_ids).toEqual(["m-featured"]);
  });

  it("returns credential_not_found for an unknown id", async () => {
    const result = await discoverAvailableModels(
      ctx.org.id,
      "00000000-0000-0000-0000-000000000000",
      scriptedListing([]).deps,
    );
    expect(result.outcome).toBe("credential_not_found");
  });

  // --- Offline providers (subscription: codex, claude-code) ---

  it("offline provider: resolves static candidates (∩ catalog) with NO listing call", async () => {
    const cred = await seedOrgModelProviderOAuth({
      orgId: ctx.org.id,
      providerId: OFFLINE_PROVIDER_ID,
    });
    // Proves the platform issues zero network calls validating a
    // subscription credential's models.
    const { deps, calls } = forbiddenListing();

    const result = await discoverAvailableModels(ctx.org.id, cred.id, deps);

    expect(calls()).toBe(0);
    expect(result.outcome).toBe("ok");
    // Every declared candidate is counted (including the uncatalogued one) —
    // the same meaning the listing path gives the number — without a single
    // upstream request.
    expect(result.candidateCount).toBe(3);
    // Derived on read, not written: "m-uncatalogued" is filtered out (not in
    // the catalog); the rest come back in declaration order. That nothing was
    // written is pinned by the raw-column assertion in the next test.
    const info = await getOrgModelProviderCredential(ctx.org.id, cred.id);
    expect(info?.available_model_ids).toEqual(["m-featured", "m-extra"]);
  });

  it("offline provider: leaves the row untouched and overrides a stale persisted array", async () => {
    const cred = await seedOrgModelProviderOAuth({
      orgId: ctx.org.id,
      providerId: OFFLINE_PROVIDER_ID,
    });
    // Simulate a pre-migration row: a snapshot written by the old code path,
    // now two generations behind the definition. It must neither be returned
    // nor rewritten — the derived list simply wins.
    await db
      .update(modelProviderCredentials)
      .set({ availableModelIds: ["m-ancient"] })
      .where(eq(modelProviderCredentials.id, cred.id));

    const { deps } = forbiddenListing();
    const result = await discoverAvailableModels(ctx.org.id, cred.id, deps);

    expect(result.outcome).toBe("ok");
    const info = await getOrgModelProviderCredential(ctx.org.id, cred.id);
    expect(info?.available_model_ids).toEqual(["m-featured", "m-extra"]);
    // The column itself is still the stale value — discovery wrote nothing.
    const [row] = await db
      .select({ ids: modelProviderCredentials.availableModelIds })
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, cred.id));
    expect(row?.ids).toEqual(["m-ancient"]);
  });
});
