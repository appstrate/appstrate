// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `discoverAvailableModels` — empirical model
 * discovery against a credential, with the prober injected so no
 * network leaves the process.
 *
 * Uses a synthetic `test-oauth-discovery` provider (registered here,
 * baseline restored in `afterAll`) so the zero-footprint invariant
 * holds — no module knowledge in core tests.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedOrgModelProviderOAuth } from "../../helpers/seed.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import { registerModelProvider } from "../../../src/services/model-providers/registry.ts";
import { registerCatalog } from "../../../src/services/pricing-catalog.ts";
import {
  discoverAvailableModels,
  type ModelDiscoveryDeps,
} from "../../../src/services/model-providers/model-discovery.ts";
import { getOrgModelProviderCredential } from "../../../src/services/model-providers/credentials.ts";
import type { TestResult } from "@appstrate/shared-types";

const PROVIDER_ID = "test-oauth-discovery";
const OFFLINE_PROVIDER_ID = "test-offline-discovery";

/**
 * Synthetic provider declaring `credentialValidation: "offline"` — exercises
 * the no-network discovery path (subscription providers codex/claude-code).
 * Reuses the same catalog as the probe provider. Candidate "m-uncatalogued"
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
    credentialValidation: "offline",
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
    displayName: "Test OAuth Discovery",
    iconUrl: "openai",
    description: "Synthetic provider exercising model discovery.",
    apiShape: "openai-responses",
    defaultBaseUrl: "https://discovery.example.test/v1",
    baseUrlOverridable: false,
    authMode: "oauth2",
    oauth: {
      clientId: "test-discovery-client",
      authorizationUrl: "https://auth.example.test/authorize",
      tokenUrl: "https://auth.example.test/token",
      refreshUrl: "https://auth.example.test/token",
      scopes: ["openid"],
      pkce: "S256",
    },
    catalogProviderId: "test-discovery-catalog",
    featuredModels: ["m-featured"],
    modelDiscoveryCandidates: ["m-featured", "m-extra", "m-gone"],
  });
}

/** Prober answering from a fixed (modelId → result) table; records calls. */
function tableProber(table: Record<string, TestResult | TestResult[]>): {
  deps: ModelDiscoveryDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const remaining = new Map(
    Object.entries(table).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]),
  );
  return {
    calls,
    deps: {
      sleep: async () => {},
      probe: async ({ modelId }) => {
        calls.push(modelId);
        const queue = remaining.get(modelId);
        if (!queue || queue.length === 0) {
          return { ok: false, latency: 1, error: "PROVIDER_ERROR", status: 404 };
        }
        return queue.length === 1 ? queue[0]! : queue.shift()!;
      },
    },
  };
}

const OK: TestResult = { ok: true, latency: 1, status: 200 };
const NOT_SERVED: TestResult = {
  ok: false,
  latency: 1,
  error: "PROVIDER_ERROR",
  status: 404,
};
const AUTH_FAILED: TestResult = { ok: false, latency: 1, error: "AUTH_FAILED", status: 401 };
const RATE_LIMITED: TestResult = {
  ok: false,
  latency: 1,
  error: "PROVIDER_ERROR",
  status: 429,
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

  it("persists the ids that answered 2xx, in candidate order", async () => {
    const cred = await seedOrgModelProviderOAuth({ orgId: ctx.org.id, providerId: PROVIDER_ID });
    const { deps } = tableProber({ "m-featured": OK, "m-extra": OK, "m-gone": NOT_SERVED });

    const result = await discoverAvailableModels(ctx.org.id, cred.id, deps);

    expect(result.outcome).toBe("ok");
    expect(result.persisted).toBe(true);
    expect(result.verifiedModelIds).toEqual(["m-featured", "m-extra"]);
    const info = await getOrgModelProviderCredential(ctx.org.id, cred.id);
    expect(info?.available_model_ids).toEqual(["m-featured", "m-extra"]);
  });

  it("aborts without persisting on AUTH_FAILED (an auth outage must not wipe a good list)", async () => {
    const cred = await seedOrgModelProviderOAuth({ orgId: ctx.org.id, providerId: PROVIDER_ID });
    const { deps, calls } = tableProber({ "m-featured": AUTH_FAILED });

    const result = await discoverAvailableModels(ctx.org.id, cred.id, deps);

    expect(result.outcome).toBe("auth_failed");
    expect(result.persisted).toBe(false);
    // Aborted on the first candidate — no further probes burned.
    expect(calls).toEqual(["m-featured"]);
    const info = await getOrgModelProviderCredential(ctx.org.id, cred.id);
    expect(info?.available_model_ids ?? null).toBeNull();
  });

  it("keeps the previous list when nothing verifies (network incident ≠ empty plan)", async () => {
    const cred = await seedOrgModelProviderOAuth({ orgId: ctx.org.id, providerId: PROVIDER_ID });
    const first = tableProber({ "m-featured": OK, "m-extra": NOT_SERVED, "m-gone": NOT_SERVED });
    await discoverAvailableModels(ctx.org.id, cred.id, first.deps);

    const allDown = tableProber({});
    const result = await discoverAvailableModels(ctx.org.id, cred.id, allDown.deps);

    expect(result.outcome).toBe("nothing_verified");
    expect(result.persisted).toBe(false);
    const info = await getOrgModelProviderCredential(ctx.org.id, cred.id);
    expect(info?.available_model_ids).toEqual(["m-featured"]);
  });

  it("retries a 429 once and counts the model when the retry succeeds", async () => {
    const cred = await seedOrgModelProviderOAuth({ orgId: ctx.org.id, providerId: PROVIDER_ID });
    const { deps, calls } = tableProber({
      "m-featured": [RATE_LIMITED, OK],
      "m-extra": NOT_SERVED,
      "m-gone": NOT_SERVED,
    });

    const result = await discoverAvailableModels(ctx.org.id, cred.id, deps);

    expect(result.outcome).toBe("ok");
    expect(result.verifiedModelIds).toEqual(["m-featured"]);
    expect(calls.filter((m) => m === "m-featured")).toHaveLength(2);
  });

  it("returns credential_not_found for an unknown id", async () => {
    const result = await discoverAvailableModels(
      ctx.org.id,
      "00000000-0000-0000-0000-000000000000",
      tableProber({}).deps,
    );
    expect(result.outcome).toBe("credential_not_found");
  });

  // --- Offline providers (subscription: codex, claude-code) ---

  it("offline provider: persists static candidates (∩ catalog) with NO probe call", async () => {
    const cred = await seedOrgModelProviderOAuth({
      orgId: ctx.org.id,
      providerId: OFFLINE_PROVIDER_ID,
    });
    // A probe dep that MUST NOT be invoked — proves the platform issues
    // zero network calls validating a subscription credential's models.
    let probeCalls = 0;
    const deps: ModelDiscoveryDeps = {
      sleep: async () => {},
      probe: async () => {
        probeCalls++;
        throw new Error("offline discovery must not probe the network");
      },
    };

    const result = await discoverAvailableModels(ctx.org.id, cred.id, deps);

    expect(probeCalls).toBe(0);
    expect(result.outcome).toBe("ok");
    expect(result.persisted).toBe(true);
    // "m-uncatalogued" is filtered out (not in the catalog); the rest persist
    // in declaration order.
    expect(result.verifiedModelIds).toEqual(["m-featured", "m-extra"]);
    const info = await getOrgModelProviderCredential(ctx.org.id, cred.id);
    expect(info?.available_model_ids).toEqual(["m-featured", "m-extra"]);
  });
});
