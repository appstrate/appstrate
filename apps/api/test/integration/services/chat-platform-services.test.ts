// SPDX-License-Identifier: Apache-2.0

/**
 * `resolveChatModel` — the chat-module seam that routes an
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

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { chatSessions, llmUsage, modelProviderCredentials, orgModels } from "@appstrate/db/schema";
import type { ChatUsageRecord } from "@appstrate/core/chat-contract";
import { decryptCredentials, encryptCredentials } from "@appstrate/connect";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, createTestUser, type TestContext } from "../../helpers/auth.ts";
import { seedOrgModelProviderOAuth } from "../../helpers/seed.ts";
import { TEST_OAUTH_MODEL_ID, TEST_OAUTH_PROVIDER_ID } from "../../helpers/test-oauth-provider.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import { initSystemModelProviderKeys } from "../../../src/services/model-registry.ts";
import { createOrgModel, listOrgModels } from "../../../src/services/org-models.ts";
import { recordChatUsage, resolveChatModel } from "../../../src/services/chat-platform-services.ts";
import { logger } from "../../../src/lib/logger.ts";

// `resolveChatModel` reads the system model registry; the HTTP harness initializes it at boot.
initSystemModelProviderKeys();

describe("resolveChatModel", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    // Restores the registry baseline, which registers `test-oauth`: this file
    // does not import the app helper that seeds it at boot.
    seedTestModelProviders();
    ctx = await createTestContext();
  });

  /** The test user's own subscription: a personal credential, never an organization one. */
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
      ownerUserId: ctx.user.id,
    });
    return row.id;
  }

  /** A subscription model is unbound: each member's own subscription serves it. */
  function createSubscriptionModel(label: string): Promise<string> {
    return createOrgModel(ctx.orgId, label, TEST_OAUTH_MODEL_ID, ctx.user.id, {
      credentialId: null,
      providerId: TEST_OAUTH_PROVIDER_ID,
    });
  }

  /** Whether the stored blob of a credential is flagged as needing a reconnect. */
  async function storedNeedsReconnection(credentialId: string): Promise<boolean> {
    const [row] = await db
      .select({ credentialsEncrypted: modelProviderCredentials.credentialsEncrypted })
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, credentialId))
      .limit(1);
    return (
      decryptCredentials<{ needsReconnection?: boolean }>(row!.credentialsEncrypted)
        .needsReconnection === true
    );
  }

  it("refuses an aliased subscription row (invalid legacy state) — falls to the gateway path", async () => {
    // The member's own subscription is present: it must not serve an aliased row either.
    await seedOauthCredential();
    // Creation refuses an alias on an unbound model (refuseUnboundAlias), so the
    // legacy row is written directly, as a write path without those invariants could leave it.
    const [row] = await db
      .insert(orgModels)
      .values({
        orgId: ctx.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        credentialId: null,
        label: "Masked Subscription",
        modelId: TEST_OAUTH_MODEL_ID,
        aliased: true,
        enabled: true,
      })
      .returning();

    const resolution = await resolveChatModel(ctx.orgId, row!.id, ctx.user.id);
    expect(resolution).toEqual({ subscription: false });
  });

  it("resolves an unbound subscription model through the payer's own subscription, on the Pi chat engine binding", async () => {
    const credentialId = await seedOauthCredential();
    const presetId = await createSubscriptionModel("Subscribed");

    const resolution = await resolveChatModel(ctx.orgId, presetId, ctx.user.id);
    expect(resolution.subscription).toBe(true);
    if (resolution.subscription && "model" in resolution) {
      expect(resolution.model.modelId).toBe(TEST_OAUTH_MODEL_ID);
      expect(resolution.model.credentialId).toBe(credentialId);
      expect(resolution.model.accessToken).toBe("test-access");
      // The binding reads the row's Pi key from the listing, not its Appstrate id.
      const row = (await listOrgModels(ctx.orgId, null)).find((m) => m.id === presetId);
      expect(row?.pi_provider).toBe("openai");
    } else {
      throw new Error(`expected a model resolution, got ${JSON.stringify(resolution)}`);
    }
  });

  describe("a subscription whose access token expired", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    /** The member's own expired subscription, and an unbound model it serves. */
    async function expiredSubscription(
      tokenEndpoint: () => Response,
    ): Promise<{ presetId: string; credentialId: string }> {
      const row = await seedOrgModelProviderOAuth({
        orgId: ctx.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        label: "Test OAuth",
        accessToken: "stale",
        refreshToken: "test-refresh",
        expiresAt: Date.now() - 10_000,
        createdBy: ctx.user.id,
        ownerUserId: ctx.user.id,
      });
      globalThis.fetch = (async () => tokenEndpoint()) as unknown as typeof fetch;
      const presetId = await createSubscriptionModel("Subscribed");
      return { presetId, credentialId: row.id };
    }

    it("resolves to a reconnect when the provider refuses the refresh token", async () => {
      const { presetId, credentialId } = await expiredSubscription(() =>
        Response.json({ error: "invalid_grant" }, { status: 400 }),
      );

      expect(await resolveChatModel(ctx.orgId, presetId, ctx.user.id)).toEqual({
        subscription: true,
        needsReconnection: true,
      });
      // The flag is stored on the member's personal credential.
      expect(await storedNeedsReconnection(credentialId)).toBe(true);
      // The next turn asks for a reconnect without a refresh.
      globalThis.fetch = (async () => {
        throw new Error("the token endpoint must not be called again");
      }) as unknown as typeof fetch;
      expect(await resolveChatModel(ctx.orgId, presetId, ctx.user.id)).toEqual({
        subscription: true,
        needsReconnection: true,
      });
    });

    it("throws, and asks for no reconnect, when the token endpoint is down", async () => {
      const { presetId, credentialId } = await expiredSubscription(
        () => new Response("down", { status: 503 }),
      );

      await expect(resolveChatModel(ctx.orgId, presetId, ctx.user.id)).rejects.toThrow();
      expect(await storedNeedsReconnection(credentialId)).toBe(false);
    });
  });

  it("serves a member-held model from that member's own subscription, never another's", async () => {
    const other = await createTestUser({ email: `member-${crypto.randomUUID()}@example.test` });
    await db.insert(modelProviderCredentials).values({
      orgId: ctx.orgId,
      ownerUserId: other.id,
      label: "Other's subscription",
      providerId: TEST_OAUTH_PROVIDER_ID,
      credentialsEncrypted: encryptCredentials({
        kind: "oauth",
        accessToken: "other-token",
        refreshToken: "other-refresh",
        expiresAt: Date.now() + 3_600_000,
        needsReconnection: false,
      }),
      createdBy: other.id,
    });
    // Unbound: no org credential, each member brings their own subscription.
    const [model] = await db
      .insert(orgModels)
      .values({
        orgId: ctx.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        credentialId: null,
        label: "Member subscription",
        // A model the subscription's catalog serves: a personal credential only
        // serves a model of its own provider family.
        modelId: TEST_OAUTH_MODEL_ID,
        enabled: true,
      })
      .returning();

    await expect(resolveChatModel(ctx.orgId, model!.id, ctx.user.id)).rejects.toMatchObject({
      status: 409,
      code: "model_credential_required",
    });
    expect(await resolveChatModel(ctx.orgId, model!.id, other.id)).toMatchObject({
      subscription: true,
      model: { accessToken: "other-token" },
    });
  });

  it("returns { subscription: false } for an unknown preset", async () => {
    const resolution = await resolveChatModel(ctx.orgId, "no-such-preset", ctx.user.id);
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
    await db
      .insert(chatSessions)
      .values({ id, orgId: ctx.orgId, spaceId: ctx.defaultSpaceId, userId: ctx.user.id });
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
      credentialId: null,
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

  it("records the credential that served the turn, kept after that credential is deleted", async () => {
    const sessionId = await seedSession("chs_credential");
    const credentialId = crypto.randomUUID();
    await recordChatUsage(record({ chatSessionId: sessionId, credentialId }));

    expect((await storedRow(sessionId))!.credentialId).toBe(credentialId);
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

  it("prices a turn without tier bands at the BASE rate, however large its sum", async () => {
    const sessionId = await seedSession("chs_pricing_tiered");
    await recordChatUsage(
      record({
        chatSessionId: sessionId,
        modelId: "gpt-5.5",
        apiShape: "openai-codex-responses",
        inputTokens: 400_000,
        outputTokens: 20_000,
        // Pi's `openai-codex/gpt-5.5` rate card, copied by hand.
        cost: {
          input: 5,
          output: 30,
          cacheRead: 0.5,
          cacheWrite: 0,
          tiers: [
            { inputTokensAbove: 272_000, input: 10, output: 45, cacheRead: 1, cacheWrite: 0 },
          ],
        },
      }),
    );

    // 0.4M×5 + 0.02M×30 = 2 + 0.6 — never the tier's 4 + 0.9.
    expect((await storedRow(sessionId))!.costUsd).toBeCloseTo(2.6, 9);
  });

  /** Haiku-5.5-like card: every rate ×5 above 100k prompt tokens. */
  const TIERED_COST = {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    tiers: [
      { inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
    ],
  };
  /** Two calls: 20k in / 1k out (base), then 30k in + 80k cached / 2k out (tier). */
  const tieredTurn = {
    modelId: "claude-haiku-5-5",
    inputTokens: 50_000,
    outputTokens: 3_000,
    cacheReadTokens: 80_000,
    cacheWriteTokens: 0,
    cost: TIERED_COST,
  };
  const TIER_BAND = {
    input_tokens_above: 100_000,
    input_tokens: 30_000,
    output_tokens: 2_000,
    cache_read_input_tokens: 80_000,
    cache_creation_input_tokens: 0,
  };

  it("prices each call of a turn at its tier from the record's bands", async () => {
    const sessionId = await seedSession("chs_pricing_bands");
    await recordChatUsage(record({ chatSessionId: sessionId, ...tieredTurn, tiers: [TIER_BAND] }));

    // Band at the tier: 0.03M×0.5 + 0.002M×2.5 + 0.08M×0.05 = 0.024.
    // Rest at base:     0.02M×0.1 + 0.001M×0.5               = 0.0025.
    const row = await storedRow(sessionId);
    expect(row!.costUsd).toBeCloseTo(0.0265, 12);
    // The ledger columns stay the turn's totals.
    expect(row!.inputTokens).toBe(50_000);
    expect(row!.cacheReadTokens).toBe(80_000);
  });

  it("drops invalid bands and prices the turn at the base rate", async () => {
    const sessionId = await seedSession("chs_pricing_bad_bands");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await recordChatUsage(
        record({
          chatSessionId: sessionId,
          ...tieredTurn,
          tiers: [{ ...TIER_BAND, input_tokens: -30_000 }],
        }),
      );
      expect(warn.mock.calls.map(([msg]) => msg)).toContain("usage: malformed tier bands dropped");
    } finally {
      warn.mockRestore();
    }

    // 0.05M×0.1 + 0.003M×0.5 + 0.08M×0.01 = 0.0073.
    expect((await storedRow(sessionId))!.costUsd).toBeCloseTo(0.0073, 12);
  });
});
