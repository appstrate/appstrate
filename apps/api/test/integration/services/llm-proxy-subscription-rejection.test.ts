// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard for the no-forging contract (issue: remove all OAuth
 * fingerprint forging). The generic llm-proxy gateway must REFUSE any
 * OAuth-subscription provider rather than forward a bare bearer upstream —
 * subscription providers are served only by their own SDK gateway. A silent
 * fall-through here would re-open the forging path.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  proxyLlmCall,
  LlmProxyUnsupportedSubscriptionError,
} from "../../../src/services/llm-proxy/core.ts";
import type { LlmProxyAdapter } from "../../../src/services/llm-proxy/types.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext } from "../../helpers/auth.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import { seedOrgModelProviderOAuth, seedOrgModel } from "../../helpers/seed.ts";

// Minimal adapter for the `test-oauth` provider's apiShape. None of its
// methods should run — the subscription guard throws before forwarding.
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
});

describe("proxyLlmCall — OAuth-subscription rejection", () => {
  it("throws LlmProxyUnsupportedSubscriptionError and never forwards upstream", async () => {
    const ctx = await createTestContext({ orgSlug: "subrej" });
    const cred = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: "test-oauth", // authMode: "oauth2"
      createdBy: ctx.user.id,
    });
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: cred.id,
      modelId: "test-model",
      enabled: true,
    });

    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      proxyLlmCall({
        adapter,
        principal: {
          kind: "api_key",
          apiKeyId: "key_test",
          orgId: ctx.orgId,
          userId: ctx.user.id,
        },
        runId: null,
        chatSessionId: null,
        upstreamPath: "/v1/responses",
        incomingHeaders: new Headers(),
        rawBody: new TextEncoder().encode(JSON.stringify({ model: model.id })),
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(LlmProxyUnsupportedSubscriptionError);

    expect(fetchCalled).toBe(false);
  });
});
