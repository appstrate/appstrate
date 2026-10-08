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
import { chatSessions, llmUsage } from "@appstrate/db/schema";
import type { ChatUsageRecord } from "@appstrate/core/chat-contract";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedOrgModelProviderOAuth } from "../../helpers/seed.ts";
import { TEST_OAUTH_PROVIDER_ID } from "../../helpers/test-oauth-provider.ts";
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

    const resolution = await resolveChatModel(ctx.orgId, presetId);
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

    const resolution = await resolveChatModel(ctx.orgId, presetId);
    expect(resolution.subscription).toBe(true);
    if (resolution.subscription && "model" in resolution) {
      expect(resolution.model.modelId).toBe("test-model");
      expect(resolution.model.accessToken).toBe("test-access");
      // The binding reads the row's Pi key from the listing, not its Appstrate id.
      const row = (await listOrgModels(ctx.orgId)).find((m) => m.id === presetId);
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

    async function expiredSubscription(tokenEndpoint: () => Response): Promise<string> {
      const row = await seedOrgModelProviderOAuth({
        orgId: ctx.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        label: "Test OAuth",
        accessToken: "stale",
        refreshToken: "test-refresh",
        expiresAt: Date.now() - 10_000,
        createdBy: ctx.user.id,
      });
      globalThis.fetch = (async () => tokenEndpoint()) as unknown as typeof fetch;
      return createOrgModel(ctx.orgId, "Subscribed", "test-model", ctx.user.id, row.id);
    }

    it("resolves to a reconnect when the provider refuses the refresh token", async () => {
      const presetId = await expiredSubscription(() =>
        Response.json({ error: "invalid_grant" }, { status: 400 }),
      );

      expect(await resolveChatModel(ctx.orgId, presetId)).toEqual({
        subscription: true,
        needsReconnection: true,
      });
      // The flag is stored: the next turn asks for a reconnect without a refresh.
      globalThis.fetch = (async () => {
        throw new Error("the token endpoint must not be called again");
      }) as unknown as typeof fetch;
      expect(await resolveChatModel(ctx.orgId, presetId)).toEqual({
        subscription: true,
        needsReconnection: true,
      });
    });

    it("throws, and asks for no reconnect, when the token endpoint is down", async () => {
      const presetId = await expiredSubscription(() => new Response("down", { status: 503 }));

      await expect(resolveChatModel(ctx.orgId, presetId)).rejects.toThrow();
      const row = (await listOrgModels(ctx.orgId)).find((m) => m.id === presetId);
      expect(row?.needs_reconnection ?? false).toBe(false);
    });
  });

  it("returns { subscription: false } for an unknown preset", async () => {
    const resolution = await resolveChatModel(ctx.orgId, "no-such-preset");
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
      expect(warn.mock.calls.map(([msg]) => msg)).toContain("chat: dropped invalid usage tiers");
    } finally {
      warn.mockRestore();
    }

    // 0.05M×0.1 + 0.003M×0.5 + 0.08M×0.01 = 0.0073.
    expect((await storedRow(sessionId))!.costUsd).toBeCloseTo(0.0073, 12);
  });
});
