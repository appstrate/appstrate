// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard for the no-forging contract (issue: remove all OAuth
 * fingerprint forging). The generic llm-proxy gateway must REFUSE any
 * OAuth-subscription connection rather than forward a bare bearer upstream —
 * subscription providers are served only by their own SDK gateway. Since
 * #2451 the proxy's serving order leaves subscriptions out, so a model only a
 * subscription serves is refused as unserved. A silent fall-through here would
 * re-open the forging path.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { proxyLlmCall } from "../../../src/services/llm-proxy/core.ts";
import type { LlmProxyAdapter } from "../../../src/services/llm-proxy/types.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext } from "../../helpers/auth.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import { initSystemModelProviderKeys } from "../../../src/services/model-registry.ts";
import { seedOrgModelProviderOAuth, seedOrgModel } from "../../helpers/seed.ts";
import { TEST_OAUTH_MODEL_ID } from "../../helpers/test-oauth-provider.ts";

// Minimal adapter for the `test-oauth` provider's apiShape. None of its
// methods should run — the call is refused before forwarding.
const adapter: LlmProxyAdapter = {
  apiShape: "openai-responses",
  buildUpstreamHeaders: () => {
    throw new Error("adapter must not be reached for a subscription provider");
  },
  parseJsonUsage: () => null,
  parseSseUsage: () => null,
};

beforeEach(async () => {
  await truncateAll();
  seedTestModelProviders();
  initSystemModelProviderKeys([]);
});

describe("proxyLlmCall — OAuth-subscription rejection", () => {
  it("serves no subscription: a model only a subscription serves is refused before any forward", async () => {
    const ctx = await createTestContext({ orgSlug: "subrej" });
    const cred = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: "test-oauth", // authMode: "oauth2"
      createdBy: ctx.user.id,
    });
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      configId: cred.configId!,
      modelId: TEST_OAUTH_MODEL_ID,
      enabled: true,
    });

    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    // The proxy's serving order leaves subscriptions out, so the configuration's
    // only connection never reaches the adapter.
    await expect(
      proxyLlmCall({
        adapter,
        principal: {
          kind: "api_key",
          apiKeyId: "key_test",
          orgId: ctx.orgId,
          userId: ctx.user.id,
        },
        payerUserId: null,
        runId: null,
        chatSessionId: null,
        requestId: "req_test",
        upstreamPath: "/v1/responses",
        incomingHeaders: new Headers(),
        rawBody: new TextEncoder().encode(JSON.stringify({ model: model.id })),
        fetchImpl,
      }),
    ).rejects.toMatchObject({ status: 409, code: "model_credential_required" });

    expect(fetchCalled).toBe(false);
  });
});
