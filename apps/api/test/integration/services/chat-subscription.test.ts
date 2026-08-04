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
import { eq } from "drizzle-orm";
import { chatSessions, llmUsage } from "@appstrate/db/schema";
import type { ChatUsageRecord } from "@appstrate/core/chat-contract";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedOrgModelProviderOAuth } from "../../helpers/seed.ts";
import { TEST_OAUTH_PROVIDER_ID } from "../../helpers/test-oauth-provider.ts";
import { createOrgModel } from "../../../src/services/org-models.ts";
import {
  recordChatUsage,
  resolveSubscriptionChatModel,
} from "../../../src/services/chat-subscription.ts";

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

  it("carries provider-native reasoning levels into the Pi chat binding", async () => {
    const credentialId = await seedOauthCredential();
    const presetId = await createOrgModel(
      ctx.orgId,
      "Subscribed Reasoning",
      "test-reasoning-model",
      ctx.user.id,
      credentialId,
    );

    const resolution = await resolveSubscriptionChatModel(ctx.orgId, presetId);
    expect(resolution.subscription).toBe(true);
    if (resolution.subscription && "model" in resolution) {
      expect(resolution.model.reasoningLevelMap).toEqual({ xhigh: "max" });
    } else {
      throw new Error(`expected a model resolution, got ${JSON.stringify(resolution)}`);
    }
  });

  it("returns { subscription: false } for an unknown preset", async () => {
    const resolution = await resolveSubscriptionChatModel(ctx.orgId, "no-such-preset");
    expect(resolution).toEqual({ subscription: false });
  });
});

/**
 * `recordChatUsage` — the in-process chat engine's own meter. Its rows must
 * carry the same pricing provenance as the proxy's, and in particular a
 * SUBSCRIPTION turn must not be mislabelled `unpriced`: codex/claude-code
 * presets resolve their rates through `catalogProviderId` (→ openai/anthropic),
 * so the platform prices them at an imputed API-equivalent on purpose.
 */
describe("recordChatUsage — pricing provenance", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chatpricing" });
  });

  async function seedSession(id: string): Promise<string> {
    await db.insert(chatSessions).values({ id, orgId: ctx.orgId, userId: ctx.user.id });
    return id;
  }

  function record(overrides: Partial<ChatUsageRecord> = {}): ChatUsageRecord {
    return {
      orgId: ctx.orgId,
      userId: ctx.user.id,
      chatSessionId: null,
      presetId: "preset-chat",
      modelId: "claude-sonnet-4-6",
      apiShape: "anthropic-messages",
      inputTokens: 1_000,
      outputTokens: 500,
      cost: { input: 3, output: 15, cacheRead: 0.3 },
      durationMs: 42,
      ...overrides,
    };
  }

  async function storedRow(chatSessionId: string) {
    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.chatSessionId, chatSessionId));
    return row;
  }

  it("a subscription-backed turn is `priced` — its imputed API-equivalent rates are real rates", async () => {
    const sessionId = await seedSession("chs_pricing_sub");
    await recordChatUsage(record({ chatSessionId: sessionId }));

    const row = await storedRow(sessionId);
    expect(row!.pricingStatus).toBe("priced");
    // And the cost is the imputed equivalent, not zero.
    expect(row!.costUsd).toBeGreaterThan(0);
  });

  it("marks a turn on a model with no rates `unpriced` instead of a silent $0", async () => {
    const sessionId = await seedSession("chs_pricing_none");
    await recordChatUsage(record({ chatSessionId: sessionId, cost: null }));

    const row = await storedRow(sessionId);
    expect(row!.pricingStatus).toBe("unpriced");
    expect(row!.costUsd).toBe(0);
  });

  it("marks a cached turn `partial` when the model carries no cache-read rate", async () => {
    const sessionId = await seedSession("chs_pricing_partial");
    await recordChatUsage(
      record({
        chatSessionId: sessionId,
        cacheReadTokens: 800,
        cost: { input: 3, output: 15 },
      }),
    );

    const row = await storedRow(sessionId);
    expect(row!.pricingStatus).toBe("partial");
  });
});
