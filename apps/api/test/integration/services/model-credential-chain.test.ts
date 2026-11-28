// SPDX-License-Identifier: Apache-2.0

/**
 * Who pays for a model (#1875, #2451). A model belongs to a configuration, and
 * the configuration's connections serve it in one order: the payer's personal
 * subscription, the payer's personal API key, an organization subscription, an
 * organization API key, then oldest first. Personal connections count only for
 * their owner, only while the configuration allows them, and never for an
 * alias; the LLM proxy and an alias never use a subscription. A built-in model
 * is served by the platform key. Pins the pure ranking (`rankCandidates`), the
 * chain in `loadModel`, a run's launch connection in `loadRunModel`, and the
 * `billed_to` listing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { listPiModels } from "@appstrate/runner-pi/pi-model";
import { modelProviderCredentials } from "@appstrate/db/schema";
import type { OrgModelInfo } from "@appstrate/shared-types";
import {
  createOrgModel,
  listOrgModels,
  loadModel,
  loadRunModel,
  requireBoundModel,
} from "../../../src/services/org-models.ts";
import {
  connectionFitsConfig,
  rankCandidates,
  servesModel,
  type CandidateQuery,
  type ConnectionCandidate,
} from "../../../src/services/model-providers/credential-chain.ts";
import { updateModelConfig } from "../../../src/services/model-configs.ts";
import { clearResolvedModelCache } from "../../../src/services/resolved-model-cache.ts";
import { initSystemModelProviderKeys } from "../../../src/services/model-registry.ts";
import { ApiError } from "../../../src/lib/errors.ts";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, memberContext, type TestContext } from "../../helpers/auth.ts";
import {
  seedModelConfig,
  seedModelConfigFor,
  seedOrgModel,
  seedOrgModelProviderKey,
  seedOrgModelProviderOAuth,
} from "../../helpers/seed.ts";
import { TEST_OAUTH_MODEL_ID, TEST_OAUTH_PROVIDER_ID } from "../../helpers/test-oauth-provider.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";

getTestApp(); // boots the model and provider registries

beforeAll(() => seedTestModelProviders({ fixedEndpoint: ["openai", "anthropic"] }));
afterAll(() => seedTestModelProviders());

const anthropicIds = listPiModels("anthropic", "anthropic-messages").map((m) => m.id);
const ANTHROPIC_A = anthropicIds[0]!;
const ANTHROPIC_B = anthropicIds[1]!;

const billedTo = (list: OrgModelInfo[], id: string) => list.find((m) => m.id === id)?.billed_to;

describe("rankCandidates — the serving order", () => {
  const at = (day: number) => new Date(`2026-01-${String(day).padStart(2, "0")}`);
  const conn = (
    id: string,
    providerId: string,
    ownerUserId: string | null,
    day: number,
  ): ConnectionCandidate => ({ id, providerId, ownerUserId, createdAt: at(day) });
  const query: CandidateQuery = {
    configProviderId: "openai",
    personalConnectionsAllowed: true,
    modelId: TEST_OAUTH_MODEL_ID,
    aliased: false,
    payerUserId: "alice",
  };
  // Created newest-first by rank, so the order cannot come from age.
  const connections = [
    conn("org-key", "openai", null, 1),
    conn("org-sub", TEST_OAUTH_PROVIDER_ID, null, 2),
    conn("alice-key", "openai", "alice", 3),
    conn("alice-sub", TEST_OAUTH_PROVIDER_ID, "alice", 4),
    conn("bob-key", "openai", "bob", 0),
  ];
  const ids = (q: Partial<CandidateQuery>) =>
    rankCandidates(connections, { ...query, ...q }).map((c) => c.id);

  it("orders personal subscription, personal key, organization subscription, organization key", () => {
    expect(ids({})).toEqual(["alice-sub", "alice-key", "org-sub", "org-key"]);
  });

  it("breaks a tie within a rank by age, oldest first", () => {
    const ranked = rankCandidates(
      [conn("newer", "openai", null, 9), conn("older", "openai", null, 1)],
      query,
    );
    expect(ranked.map((c) => c.id)).toEqual(["older", "newer"]);
  });

  it("counts a member's personal connections for that member only", () => {
    expect(ids({ payerUserId: "bob" })).toEqual(["bob-key", "org-sub", "org-key"]);
  });

  it("drops every personal connection without a payer, when the configuration disallows them, and for an alias", () => {
    expect(ids({ payerUserId: null })).toEqual(["org-sub", "org-key"]);
    expect(ids({ personalConnectionsAllowed: false })).toEqual(["org-sub", "org-key"]);
    // An alias is served by the organization, and never by a subscription.
    expect(ids({ aliased: true })).toEqual(["org-key"]);
  });

  it("leaves the subscriptions out for the LLM proxy", () => {
    expect(ids({ viaProxy: true })).toEqual(["alice-key", "org-key"]);
  });

  it("keeps only connections that serve the model", () => {
    const ranked = rankCandidates(
      [conn("anthropic", "anthropic", null, 1), conn("openai", "openai", null, 2)],
      { ...query, modelId: "gpt-5.5" },
    );
    expect(ranked.map((c) => c.id)).toEqual(["openai"]);
    // A fixed catalog provider does not serve an id outside its catalog.
    expect(
      rankCandidates([conn("openai", "openai", null, 1)], { ...query, modelId: "nope" }),
    ).toEqual([]);
  });
});

describe("servesModel / connectionFitsConfig", () => {
  it("files a wrapper under its family's configuration, a gateway under its own provider only", () => {
    expect(connectionFitsConfig(TEST_OAUTH_PROVIDER_ID, "openai")).toBe(true);
    expect(connectionFitsConfig("anthropic", "openai")).toBe(false);
    expect(connectionFitsConfig("openai-compatible", "openai-compatible")).toBe(true);
    expect(connectionFitsConfig("openai", "openai-compatible")).toBe(false);
  });

  it("serves any id on a gateway, catalog ids only on a fixed provider", () => {
    expect(servesModel("openai-compatible", "openai-compatible", "anything-at-all")).toBe(true);
    expect(servesModel("anthropic", "anthropic", ANTHROPIC_A)).toBe(true);
    expect(servesModel("anthropic", "anthropic", "claude-not-in-catalog")).toBe(false);
  });
});

describe("model resolution — the configuration's connections", () => {
  let ctx: TestContext;
  let bob: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chainorg" });
    bob = await memberContext(ctx, "member");
  });
  afterAll(() => initSystemModelProviderKeys());

  const anthropicConfig = () => seedModelConfigFor(ctx.orgId, "anthropic");
  const openaiConfig = () => seedModelConfigFor(ctx.orgId, "openai");

  async function orgAnthropicKey(apiKey = "sk-org") {
    return seedOrgModelProviderKey({
      orgId: ctx.orgId,
      label: "Org Anthropic",
      providerId: "anthropic",
      apiShape: "anthropic-messages",
      apiKey,
      configId: await anthropicConfig(),
    });
  }

  async function personalKey(userId: string, providerId: string, apiKey: string) {
    const row = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      label: `Personal ${apiKey}`,
      providerId,
      apiKey,
      ownerUserId: userId,
    });
    // The seed bypasses the credential service, which clears the cache on every mutation.
    clearResolvedModelCache();
    return row;
  }

  const personalAnthropicKey = (userId: string, apiKey: string) =>
    personalKey(userId, "anthropic", apiKey);

  const anthropicModel = async (modelId = ANTHROPIC_A, label = "Claude") =>
    createOrgModel(ctx.orgId, label, modelId, ctx.user.id, await anthropicConfig());

  const deleteConnection = async (id: string) => {
    await db.delete(modelProviderCredentials).where(eq(modelProviderCredentials.id, id));
    clearResolvedModelCache();
  };

  it("walks the serving order: personal subscription, personal key, organization subscription, organization key", async () => {
    const model = await createOrgModel(
      ctx.orgId,
      "GPT",
      TEST_OAUTH_MODEL_ID,
      ctx.user.id,
      await openaiConfig(),
    );
    const orgKey = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      providerId: "openai",
      label: "Org key",
      apiKey: "sk-org",
    });
    const orgSub = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: TEST_OAUTH_PROVIDER_ID,
      label: "Org subscription",
      accessToken: "org-sub-token",
    });
    const aliceKey = await personalKey(ctx.user.id, "openai", "sk-alice");
    const aliceSub = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: TEST_OAUTH_PROVIDER_ID,
      label: "Alice's subscription",
      accessToken: "alice-sub-token",
      ownerUserId: ctx.user.id,
    });
    clearResolvedModelCache();

    const servedFor = async (payer: string | null, viaProxy = false) =>
      (await loadModel(ctx.orgId, model, payer, { viaProxy }))?.credentialId;

    expect(await servedFor(ctx.user.id)).toBe(aliceSub.id);
    // The proxy skips the subscriptions.
    expect(await servedFor(ctx.user.id, true)).toBe(aliceKey.id);
    // Bob and a call with no payer start at the organization.
    expect(await servedFor(bob.user.id)).toBe(orgSub.id);
    expect(await servedFor(null)).toBe(orgSub.id);
    expect(await servedFor(null, true)).toBe(orgKey.id);

    await deleteConnection(aliceSub.id);
    expect(await servedFor(ctx.user.id)).toBe(aliceKey.id);
    await deleteConnection(aliceKey.id);
    expect(await servedFor(ctx.user.id)).toBe(orgSub.id);
    await deleteConnection(orgSub.id);
    expect(await servedFor(ctx.user.id)).toBe(orgKey.id);
  });

  it("ignores personal connections while the configuration disallows them", async () => {
    const org = await orgAnthropicKey();
    const model = await anthropicModel();
    await personalAnthropicKey(ctx.user.id, "sk-alice");
    expect(await loadModel(ctx.orgId, model, ctx.user.id)).toMatchObject({
      credentialSource: "user",
      apiKey: "sk-alice",
    });

    // Switched through the service the route uses, which drops the resolved-model cache.
    await updateModelConfig(ctx.orgId, await anthropicConfig(), {
      personalConnectionsAllowed: false,
    });
    expect(await loadModel(ctx.orgId, model, ctx.user.id)).toMatchObject({
      credentialSource: "org",
      credentialId: org.id,
      apiKey: "sk-org",
    });
    expect(billedTo(await listOrgModels(ctx.orgId, ctx.user.id), model)).toBe("org");
  });

  it("leaves a model of a personal-off configuration unserved for a member when there is no organization connection", async () => {
    const model = await anthropicModel();
    await personalAnthropicKey(ctx.user.id, "sk-alice");
    await updateModelConfig(ctx.orgId, await anthropicConfig(), {
      personalConnectionsAllowed: false,
    });

    expect(await loadModel(ctx.orgId, model, ctx.user.id)).toMatchObject({
      credentialSource: null,
      apiKey: "",
    });
  });

  it("never serves an aliased model with a personal key", async () => {
    const org = await orgAnthropicKey();
    const alias = await seedOrgModel({
      orgId: ctx.orgId,
      configId: await anthropicConfig(),
      modelId: ANTHROPIC_A,
      label: "Appstrate Medium",
      aliased: true,
    });
    await personalAnthropicKey(ctx.user.id, "sk-alice");

    expect(await loadModel(ctx.orgId, alias.id, ctx.user.id)).toMatchObject({
      credentialSource: "org",
      credentialId: org.id,
      apiKey: "sk-org",
      aliased: true,
    });
    expect(billedTo(await listOrgModels(ctx.orgId, ctx.user.id), alias.id)).toBe("org");
  });

  it("resolves a model unserved for a member without a key, and on the member's own key once they add one", async () => {
    const model = await anthropicModel();

    const without = await loadModel(ctx.orgId, model, bob.user.id);
    expect(without).toMatchObject({ credentialSource: null, apiKey: "", providerId: "anthropic" });
    expect(without!.credentialId).toBeUndefined();

    await personalAnthropicKey(bob.user.id, "sk-bob");
    expect(await loadModel(ctx.orgId, model, bob.user.id)).toMatchObject({
      credentialSource: "user",
      apiKey: "sk-bob",
    });
  });

  it("refuses an unserved model as a spend with 409 model_credential_required", async () => {
    const model = await anthropicModel();
    const resolved = await loadModel(ctx.orgId, model, bob.user.id);

    let thrown: unknown;
    try {
      requireBoundModel(resolved!, bob.user.id);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(409);
    expect((thrown as ApiError).code).toBe("model_credential_required");

    await personalAnthropicKey(bob.user.id, "sk-bob");
    const withKey = await loadModel(ctx.orgId, model, bob.user.id);
    expect(requireBoundModel(withKey!, bob.user.id).credentialSource).toBe("user");
  });

  it("gives each of two members their own connection when they resolve the same model concurrently", async () => {
    const model = await anthropicModel();
    await personalAnthropicKey(ctx.user.id, "sk-alice");
    await personalAnthropicKey(bob.user.id, "sk-bob");

    // Cold cache, then warm, in both orders: a shared entry would hand one
    // member's decrypted key to the other.
    for (let round = 0; round < 3; round++) {
      const [alice, bobResolved] = await Promise.all([
        loadModel(ctx.orgId, model, ctx.user.id),
        loadModel(ctx.orgId, model, bob.user.id),
      ]);
      expect(alice!.apiKey).toBe("sk-alice");
      expect(bobResolved!.apiKey).toBe("sk-bob");

      const [bobAgain, aliceAgain] = await Promise.all([
        loadModel(ctx.orgId, model, bob.user.id),
        loadModel(ctx.orgId, model, ctx.user.id),
      ]);
      expect(bobAgain!.apiKey).toBe("sk-bob");
      expect(aliceAgain!.apiKey).toBe("sk-alice");
    }
  });

  it("serves a system model with the platform key, even to a holder of a personal key of its family", async () => {
    initSystemModelProviderKeys([
      {
        id: "sys-anthropic",
        providerId: "anthropic",
        apiKey: "sk-system",
        models: [{ id: "sys-claude", modelId: ANTHROPIC_A }],
      },
    ]);
    await personalAnthropicKey(ctx.user.id, "sk-alice");

    for (const payer of [ctx.user.id, bob.user.id]) {
      expect(await loadModel(ctx.orgId, "sys-claude", payer)).toMatchObject({
        credentialSource: "system",
        apiKey: "sk-system",
      });
    }
  });

  it("serves a model of an organization subscription's configuration to every caller", async () => {
    const subscription = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: TEST_OAUTH_PROVIDER_ID,
      label: "Org subscription",
      accessToken: "org-subscription-token",
    });
    const id = await createOrgModel(
      ctx.orgId,
      "Subscription",
      TEST_OAUTH_MODEL_ID,
      ctx.user.id,
      subscription.configId!,
    );

    // A member, and a call with no payer (schedule, API key), spend the organization's.
    for (const payer of [bob.user.id, null]) {
      expect(await loadModel(ctx.orgId, id, payer)).toMatchObject({
        credentialSource: "org",
        credentialId: subscription.id,
        apiKey: "org-subscription-token",
      });
    }
  });

  it("lists a model of a configuration without connections with no payer", async () => {
    const id = await anthropicModel();

    expect((await listOrgModels(ctx.orgId, null)).find((m) => m.id === id)).toMatchObject({
      config_id: await anthropicConfig(),
      providerId: "anthropic",
      needs_reconnection: false,
      billed_to: null,
    });
  });

  it("names the payer side per caller in billed_to", async () => {
    await orgAnthropicKey();
    const withOrg = await anthropicModel(ANTHROPIC_A, "With org");
    const gatewayConfig = await seedModelConfig({
      orgId: ctx.orgId,
      providerId: "openai-compatible",
      baseUrl: "https://gateway.example.test/v1",
    });
    const personalOnly = await createOrgModel(
      ctx.orgId,
      "Personal only",
      "any-gateway-model",
      ctx.user.id,
      gatewayConfig,
    );
    await personalAnthropicKey(ctx.user.id, "sk-alice");
    await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      providerId: "openai-compatible",
      label: "Alice gateway",
      apiKey: "sk-alice-gw",
      ownerUserId: ctx.user.id,
      configId: gatewayConfig,
    });
    clearResolvedModelCache();

    const forAlice = await listOrgModels(ctx.orgId, ctx.user.id);
    // Alice's own key ranks before the organization's.
    expect(billedTo(forAlice, withOrg)).toBe("user");
    expect(billedTo(forAlice, personalOnly)).toBe("user");

    const forBob = await listOrgModels(ctx.orgId, bob.user.id);
    expect(billedTo(forBob, withOrg)).toBe("org");
    expect(billedTo(forBob, personalOnly)).toBeNull();

    const forNobody = await listOrgModels(ctx.orgId, null);
    expect(billedTo(forNobody, withOrg)).toBe("org");
    expect(billedTo(forNobody, personalOnly)).toBeNull();
  });

  it("a run's personal connection keeps serving it after the payer adds a subscription", async () => {
    const model = await createOrgModel(
      ctx.orgId,
      "GPT",
      TEST_OAUTH_MODEL_ID,
      ctx.user.id,
      await openaiConfig(),
    );
    const mine = await personalKey(ctx.user.id, "openai", "sk-alice");
    const subscription = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: TEST_OAUTH_PROVIDER_ID,
      label: "Alice's subscription",
      ownerUserId: ctx.user.id,
    });
    clearResolvedModelCache();

    // The chain now prefers the subscription; the run launched before it keeps its connection.
    expect(await loadModel(ctx.orgId, model, ctx.user.id)).toMatchObject({
      credentialId: subscription.id,
    });
    expect(
      await loadRunModel(ctx.orgId, model, { credentialId: mine.id, payerUserId: ctx.user.id }),
    ).toMatchObject({
      credentialSource: "user",
      credentialId: mine.id,
      apiKey: "sk-alice",
    });
  });

  it("a run's personal connection serves only the payer the run recorded", async () => {
    const model = await anthropicModel();
    const mine = await personalAnthropicKey(ctx.user.id, "sk-alice");

    expect(
      await loadRunModel(ctx.orgId, model, { credentialId: mine.id, payerUserId: bob.user.id }),
    ).toBeNull();
  });

  it("a run's personal connection stops serving it once the configuration disallows personal connections", async () => {
    const model = await anthropicModel();
    const mine = await personalAnthropicKey(ctx.user.id, "sk-alice");

    expect(
      await loadRunModel(ctx.orgId, model, { credentialId: mine.id, payerUserId: ctx.user.id }),
    ).toMatchObject({
      credentialId: mine.id,
      apiKey: "sk-alice",
    });
    await updateModelConfig(ctx.orgId, await anthropicConfig(), {
      personalConnectionsAllowed: false,
    });
    expect(
      await loadRunModel(ctx.orgId, model, { credentialId: mine.id, payerUserId: ctx.user.id }),
    ).toBeNull();
  });

  it("a run whose launch connection is gone is served as the model is now, by the organization only", async () => {
    const org = await orgAnthropicKey();
    const model = await anthropicModel();
    const unservedModel = await anthropicModel(ANTHROPIC_B, "Claude B");
    await deleteConnection(org.id);
    initSystemModelProviderKeys([
      {
        id: "sys-anthropic",
        providerId: "anthropic",
        apiKey: "sk-system",
        models: [{ id: "sys-claude", modelId: ANTHROPIC_A }],
      },
    ]);
    // The launching member and another member hold keys of the configuration.
    await personalAnthropicKey(ctx.user.id, "sk-alice");
    await personalAnthropicKey(bob.user.id, "sk-bob");

    for (const id of [model, unservedModel]) {
      const resolved = await loadRunModel(ctx.orgId, id, {
        credentialId: null,
        payerUserId: ctx.user.id,
      });
      expect(resolved).toMatchObject({ credentialSource: null, apiKey: "" });
      const thrown = (() => {
        try {
          requireBoundModel(resolved!, null);
        } catch (err) {
          return err;
        }
      })();
      expect((thrown as ApiError).code).toBe("model_credential_required");
    }

    expect(
      await loadRunModel(ctx.orgId, "sys-claude", { credentialId: null, payerUserId: ctx.user.id }),
    ).toMatchObject({ credentialSource: "system" });

    // An organization connection id resolves the model as it is now, too.
    const fresh = await orgAnthropicKey("sk-org-2");
    clearResolvedModelCache();
    expect(
      await loadRunModel(ctx.orgId, model, { credentialId: fresh.id, payerUserId: ctx.user.id }),
    ).toMatchObject({ credentialId: fresh.id, apiKey: "sk-org-2" });
  });

  it("a personal connection whose key is not in the keyring is skipped for the member's next one", async () => {
    const model = await anthropicModel();
    const mine = await personalAnthropicKey(ctx.user.id, "sk-alice");
    // Sealed under a key id this process does not hold.
    const [version, , payload] = mine.credentialsEncrypted.split(":");
    await db
      .update(modelProviderCredentials)
      .set({ credentialsEncrypted: `${version}:unknown-kid:${payload}` })
      .where(eq(modelProviderCredentials.id, mine.id));
    const next = await personalAnthropicKey(ctx.user.id, "sk-alice-next");

    expect(await loadModel(ctx.orgId, model, ctx.user.id)).toMatchObject({
      credentialSource: "user",
      credentialId: next.id,
      apiKey: "sk-alice-next",
    });
    expect(billedTo(await listOrgModels(ctx.orgId, ctx.user.id), model)).toBe("user");
  });
});
