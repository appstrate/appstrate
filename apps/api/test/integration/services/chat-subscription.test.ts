// SPDX-License-Identifier: Apache-2.0

/**
 * `resolveSubscriptionChatModel` — the chat-module seam that routes an
 * oauth-subscription model to the in-process Pi chat engine.
 *
 * Focus here: the aliased fail-close. Alias creation AND update reject
 * `aliased` for oauth2 providers, and the run launcher fail-closes on such a
 * row too (`assertOauthRunNotAliased`) — chat must not be the one path that
 * quietly executes the real hidden binding. A legacy/hand-written aliased
 * oauth row therefore resolves to `{ subscription: false }`, falling to the
 * LLM gateway (which rejects oauth-subscription models with an alias-safe
 * message).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedOrgModelProviderOAuth } from "../../helpers/seed.ts";
import { TEST_OAUTH_PROVIDER_ID } from "../../helpers/test-oauth-provider.ts";
import { createOrgModel } from "../../../src/services/org-models.ts";
import { resolveSubscriptionChatModel } from "../../../src/services/chat-subscription.ts";

describe("resolveSubscriptionChatModel", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  async function seedOauthCredential(): Promise<string> {
    const row = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: TEST_OAUTH_PROVIDER_ID,
      label: "Test OAuth",
      accessToken: "test-access",
      refreshToken: "test-refresh",
      // Fresh token — a null/past expiry makes the resolver hit the (absent)
      // refresh endpoint over the network.
      expiresAt: Date.now() + 3_600_000,
      createdBy: ctx.user.id,
    });
    return row.id;
  }

  it("refuses an aliased oauth-subscription row (invalid legacy state) — falls to the gateway path", async () => {
    const credentialId = await seedOauthCredential();
    // Insert through the service layer, which (like a legacy row) carries no
    // alias invariants — the route guards are what normally forbid this state.
    const presetId = await createOrgModel(
      ctx.orgId,
      "Masked Subscription",
      "test-model",
      ctx.user.id,
      credentialId,
      { aliased: true },
    );

    const resolution = await resolveSubscriptionChatModel(ctx.orgId, presetId);
    expect(resolution).toEqual({ subscription: false });
  });

  it("resolves a non-aliased oauth-subscription row to the Pi chat engine binding", async () => {
    const credentialId = await seedOauthCredential();
    const presetId = await createOrgModel(
      ctx.orgId,
      "Subscribed",
      "test-model",
      ctx.user.id,
      credentialId,
    );

    const resolution = await resolveSubscriptionChatModel(ctx.orgId, presetId);
    expect(resolution.subscription).toBe(true);
    if (resolution.subscription && "model" in resolution) {
      expect(resolution.model.modelId).toBe("test-model");
      expect(resolution.model.accessToken).toBe("test-access");
    } else {
      throw new Error(`expected a model resolution, got ${JSON.stringify(resolution)}`);
    }
  });

  it("returns { subscription: false } for an unknown preset", async () => {
    const resolution = await resolveSubscriptionChatModel(ctx.orgId, "no-such-preset");
    expect(resolution).toEqual({ subscription: false });
  });
});
