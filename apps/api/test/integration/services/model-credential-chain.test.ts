// SPDX-License-Identifier: Apache-2.0

/**
 * Who pays for a model. A member's own credential serves a model it applies to,
 * first; then the org binding; an unbound model (`credential_id` NULL) with no
 * credential for the caller resolves unbound and cannot be spent. Pins the chain
 * in `loadModel`, the LLM proxy's subscription-free chain, the run's pinned
 * credential in `loadPinnedModel`, the write-side invariants, and the `billed_to`
 * listing.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { encryptCredentials } from "@appstrate/connect";
import { listPiModels } from "@appstrate/runner-pi/pi-model";
import { modelProviderCredentials, organizations } from "@appstrate/db/schema";
import type { OrgModelInfo } from "@appstrate/shared-types";
import {
  createOrgModel,
  listOrgModels,
  loadModel,
  loadPinnedModel,
  requireBoundModel,
  resolveModel,
  setDefaultModel,
} from "../../../src/services/org-models.ts";
import { applicableCredentialIds } from "../../../src/services/model-providers/credential-chain.ts";
import { clearResolvedModelCache } from "../../../src/services/resolved-model-cache.ts";
import { initSystemModelProviderKeys } from "../../../src/services/model-registry.ts";
import { ApiError } from "../../../src/lib/errors.ts";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, memberContext, type TestContext } from "../../helpers/auth.ts";
import {
  seedOrgModel,
  seedOrgModelProviderKey,
  seedOrgModelProviderOAuth,
} from "../../helpers/seed.ts";
import { TEST_OAUTH_MODEL_ID, TEST_OAUTH_PROVIDER_ID } from "../../helpers/test-oauth-provider.ts";

getTestApp(); // boots the model and provider registries

const anthropicIds = listPiModels("anthropic", "anthropic-messages").map((m) => m.id);
const ANTHROPIC_A = anthropicIds[0]!;
const ANTHROPIC_B = anthropicIds[1]!;

const billedTo = (list: OrgModelInfo[], id: string) => list.find((m) => m.id === id)?.billed_to;

describe("applicableCredentialIds", () => {
  it("keeps the credentials that serve the model, oldest first", () => {
    const older = new Date("2026-01-01");
    const newer = new Date("2026-02-01");
    expect(
      applicableCredentialIds(
        [
          { id: "newer", providerId: "anthropic", createdAt: newer },
          { id: "other", providerId: "openai", createdAt: older },
          { id: "older", providerId: "anthropic", createdAt: older },
        ],
        { providerId: "anthropic", modelId: ANTHROPIC_A },
      ),
    ).toEqual(["older", "newer"]);
  });

  it("drops the subscriptions when asked to, and only then", () => {
    const credentials = [
      { id: "subscription", providerId: TEST_OAUTH_PROVIDER_ID, createdAt: new Date("2026-01-01") },
      { id: "key", providerId: "openai", createdAt: new Date("2026-02-01") },
    ];
    const target = { providerId: "openai", modelId: TEST_OAUTH_MODEL_ID };
    expect(applicableCredentialIds(credentials, target)).toEqual(["subscription", "key"]);
    expect(applicableCredentialIds(credentials, target, { excludeSubscriptions: true })).toEqual([
      "key",
    ]);
  });
});

describe("model resolution — a member's own credential first", () => {
  let ctx: TestContext;
  let bob: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chainorg" });
    bob = await memberContext(ctx, "member");
  });
  afterAll(() => initSystemModelProviderKeys());

  async function orgAnthropicKey(apiKey = "sk-org") {
    return seedOrgModelProviderKey({
      orgId: ctx.orgId,
      label: "Org Anthropic",
      providerId: "anthropic",
      apiShape: "anthropic-messages",
      apiKey,
    });
  }

  async function orgOpenAiKey() {
    return seedOrgModelProviderKey({
      orgId: ctx.orgId,
      label: "Org OpenAI",
      providerId: "openai",
      apiShape: "openai-responses",
      apiKey: "sk-org",
    });
  }

  async function personalKey(userId: string, providerId: string, apiKey: string) {
    const [row] = await db
      .insert(modelProviderCredentials)
      .values({
        orgId: ctx.orgId,
        label: `Personal ${apiKey}`,
        providerId,
        credentialsEncrypted: encryptCredentials({ kind: "api_key", apiKey }),
        ownerUserId: userId,
      })
      .returning();
    // The direct insert bypasses the credential service, which clears the cache on every personal mutation.
    clearResolvedModelCache();
    return row!;
  }

  const personalAnthropicKey = (userId: string, apiKey: string) =>
    personalKey(userId, "anthropic", apiKey);

  it("serves an org anthropic model with the owner's personal key, and the org key to anyone else", async () => {
    const org = await orgAnthropicKey();
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: org.id,
      providerId: "anthropic",
      modelId: ANTHROPIC_A,
      label: "Claude",
    });
    const mine = await personalAnthropicKey(ctx.user.id, "sk-alice");

    expect(await loadModel(ctx.orgId, model.id, ctx.user.id)).toMatchObject({
      credentialSource: "org",
      credentialId: mine.id,
      apiKey: "sk-alice",
    });
    expect(await loadModel(ctx.orgId, model.id, bob.user.id)).toMatchObject({
      credentialSource: "org",
      credentialId: org.id,
      apiKey: "sk-org",
    });
    // An API key spends no member's credential.
    expect(await loadModel(ctx.orgId, model.id, null)).toMatchObject({ credentialId: org.id });
  });

  it("never serves an aliased model with a personal key", async () => {
    const org = await orgAnthropicKey();
    const alias = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: org.id,
      providerId: "anthropic",
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

  it("resolves an unbound model unbound for a member without a key, and on the member's own key once they add one", async () => {
    const unbound = await createOrgModel(ctx.orgId, "Claude", ANTHROPIC_A, ctx.user.id, {
      credentialId: null,
      providerId: "anthropic",
    });

    const without = await loadModel(ctx.orgId, unbound, bob.user.id);
    expect(without).toMatchObject({ credentialSource: null, apiKey: "", providerId: "anthropic" });
    expect(without!.credentialId).toBeUndefined();

    await personalAnthropicKey(bob.user.id, "sk-bob");
    expect(await loadModel(ctx.orgId, unbound, bob.user.id)).toMatchObject({
      credentialSource: "org",
      apiKey: "sk-bob",
    });
  });

  it("refuses an unbound model as a spend with 409 model_credential_required", async () => {
    const unbound = await createOrgModel(ctx.orgId, "Claude", ANTHROPIC_A, ctx.user.id, {
      credentialId: null,
      providerId: "anthropic",
    });
    const model = await loadModel(ctx.orgId, unbound, bob.user.id);

    let thrown: unknown;
    try {
      requireBoundModel(model!);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(409);
    expect((thrown as ApiError).code).toBe("model_credential_required");

    await personalAnthropicKey(bob.user.id, "sk-bob");
    const withKey = await loadModel(ctx.orgId, unbound, bob.user.id);
    expect(requireBoundModel(withKey!).credentialSource).toBe("org");
  });

  it("ignores personal credentials while the organization has switched them off", async () => {
    const org = await orgAnthropicKey();
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: org.id,
      providerId: "anthropic",
      modelId: ANTHROPIC_A,
      label: "Claude",
    });
    await personalAnthropicKey(ctx.user.id, "sk-alice");
    await db
      .update(organizations)
      .set({ orgSettings: { personal_model_credentials: false } })
      .where(eq(organizations.id, ctx.orgId));

    expect(await loadModel(ctx.orgId, model.id, ctx.user.id)).toMatchObject({
      credentialId: org.id,
      apiKey: "sk-org",
    });
  });

  it("gives each of two members their own credential when they resolve the same model concurrently", async () => {
    const org = await orgAnthropicKey();
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: org.id,
      providerId: "anthropic",
      modelId: ANTHROPIC_A,
      label: "Claude",
    });
    await personalAnthropicKey(ctx.user.id, "sk-alice");
    await personalAnthropicKey(bob.user.id, "sk-bob");

    // Cold cache, then warm, in both orders: a shared entry would hand one
    // member's decrypted key to the other.
    for (let round = 0; round < 3; round++) {
      const [alice, bobResolved] = await Promise.all([
        loadModel(ctx.orgId, model.id, ctx.user.id),
        loadModel(ctx.orgId, model.id, bob.user.id),
      ]);
      expect(alice!.apiKey).toBe("sk-alice");
      expect(bobResolved!.apiKey).toBe("sk-bob");

      const [bobAgain, aliceAgain] = await Promise.all([
        loadModel(ctx.orgId, model.id, bob.user.id),
        loadModel(ctx.orgId, model.id, ctx.user.id),
      ]);
      expect(bobAgain!.apiKey).toBe("sk-bob");
      expect(aliceAgain!.apiKey).toBe("sk-alice");
    }
  });

  it("resolves the org default through the payer's chain", async () => {
    const org = await orgAnthropicKey();
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: org.id,
      providerId: "anthropic",
      modelId: ANTHROPIC_A,
      label: "Claude",
    });
    await setDefaultModel(ctx.orgId, model.id);
    await personalAnthropicKey(ctx.user.id, "sk-alice");

    expect(await resolveModel(ctx.orgId, "@acme/agent", null, ctx.user.id)).toMatchObject({
      apiKey: "sk-alice",
    });
    expect(await resolveModel(ctx.orgId, "@acme/agent", null, bob.user.id)).toMatchObject({
      apiKey: "sk-org",
    });
  });

  it("serves a system model with the owner's personal key of its family, the platform key to others", async () => {
    initSystemModelProviderKeys([
      {
        id: "sys-anthropic",
        providerId: "anthropic",
        apiKey: "sk-system",
        models: [{ id: "sys-claude", modelId: ANTHROPIC_A }],
      },
    ]);
    await personalAnthropicKey(ctx.user.id, "sk-alice");

    expect(await loadModel(ctx.orgId, "sys-claude", ctx.user.id)).toMatchObject({
      credentialSource: "org",
      apiKey: "sk-alice",
    });
    expect(await loadModel(ctx.orgId, "sys-claude", bob.user.id)).toMatchObject({
      credentialSource: "system",
      apiKey: "sk-system",
    });
  });

  it("refuses a member's personal credential as a model's binding", async () => {
    const mine = await personalAnthropicKey(ctx.user.id, "sk-alice");

    let thrown: unknown;
    try {
      await createOrgModel(ctx.orgId, "Mine", ANTHROPIC_A, ctx.user.id, {
        credentialId: mine.id,
        providerId: "anthropic",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(400);
    expect((thrown as ApiError).code).toBe("personal_credential_not_bindable");
  });

  it("refuses an organization subscription as a model's binding", async () => {
    const subscription = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: TEST_OAUTH_PROVIDER_ID,
      label: "Org subscription",
    });

    let thrown: unknown;
    try {
      await createOrgModel(ctx.orgId, "Subscription", TEST_OAUTH_MODEL_ID, ctx.user.id, {
        credentialId: subscription.id,
        providerId: TEST_OAUTH_PROVIDER_ID,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(400);
    expect((thrown as ApiError).code).toBe("personal_credential_not_bindable");
  });

  it("accepts an unbound model named by its provider, listed with no credential", async () => {
    const id = await createOrgModel(ctx.orgId, "Claude", ANTHROPIC_A, ctx.user.id, {
      credentialId: null,
      providerId: "anthropic",
    });

    expect((await listOrgModels(ctx.orgId, null)).find((m) => m.id === id)).toMatchObject({
      credentialId: null,
      providerId: "anthropic",
      needs_reconnection: false,
      credential_label: null,
      billed_to: null,
    });
  });

  it("names the payer side per member in billed_to", async () => {
    const org = await orgAnthropicKey();
    const bound = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: org.id,
      providerId: "anthropic",
      modelId: ANTHROPIC_A,
      label: "Bound",
    });
    const unbound = await createOrgModel(ctx.orgId, "Unbound", ANTHROPIC_B, ctx.user.id, {
      credentialId: null,
      providerId: "anthropic",
    });
    await personalAnthropicKey(ctx.user.id, "sk-alice");

    const forAlice = await listOrgModels(ctx.orgId, ctx.user.id);
    // A personal credential that applies is the payer, even over the org binding.
    expect(billedTo(forAlice, bound.id)).toBe("user");
    expect(billedTo(forAlice, unbound)).toBe("user");

    const forBob = await listOrgModels(ctx.orgId, bob.user.id);
    expect(billedTo(forBob, bound.id)).toBe("org");
    expect(billedTo(forBob, unbound)).toBeNull();

    expect(billedTo(await listOrgModels(ctx.orgId, null), bound.id)).toBe("org");
  });

  it("the LLM proxy's chain skips a personal subscription and serves the org key", async () => {
    const org = await orgOpenAiKey();
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: org.id,
      providerId: "openai",
      modelId: TEST_OAUTH_MODEL_ID,
      label: "GPT",
    });
    const subscription = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: TEST_OAUTH_PROVIDER_ID,
      label: "Alice's subscription",
      ownerUserId: ctx.user.id,
    });
    clearResolvedModelCache();

    expect(await loadModel(ctx.orgId, model.id, ctx.user.id)).toMatchObject({
      credentialId: subscription.id,
    });
    expect(await loadModel(ctx.orgId, model.id, ctx.user.id, { viaProxy: true })).toMatchObject({
      credentialSource: "org",
      credentialId: org.id,
      apiKey: "sk-org",
    });
  });

  it("a pinned personal credential keeps serving its run after the payer adds a subscription", async () => {
    const org = await orgOpenAiKey();
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: org.id,
      providerId: "openai",
      modelId: TEST_OAUTH_MODEL_ID,
      label: "GPT",
    });
    const mine = await personalKey(ctx.user.id, "openai", "sk-alice");
    const subscription = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: TEST_OAUTH_PROVIDER_ID,
      label: "Alice's subscription",
      ownerUserId: ctx.user.id,
    });
    clearResolvedModelCache();

    // The chain now prefers the subscription; the run launched before it keeps its pin.
    expect(await loadModel(ctx.orgId, model.id, ctx.user.id)).toMatchObject({
      credentialId: subscription.id,
    });
    expect(
      await loadPinnedModel(ctx.orgId, model.id, { credentialId: mine.id, source: "org" }),
    ).toMatchObject({
      credentialSource: "org",
      credentialId: mine.id,
      apiKey: "sk-alice",
    });
  });

  it("a run whose pinned credential is gone is never served by another credential", async () => {
    const org = await orgAnthropicKey();
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: org.id,
      providerId: "anthropic",
      modelId: ANTHROPIC_A,
      label: "Claude",
    });
    const alias = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: org.id,
      providerId: "anthropic",
      modelId: ANTHROPIC_A,
      label: "Appstrate Medium",
      aliased: true,
    });
    initSystemModelProviderKeys([
      {
        id: "sys-anthropic",
        providerId: "anthropic",
        apiKey: "sk-system",
        models: [{ id: "sys-claude", modelId: ANTHROPIC_A }],
      },
    ]);
    // The run launched on the member's personal key, which was then deleted: its pin is null.
    await personalAnthropicKey(ctx.user.id, "sk-alice");
    clearResolvedModelCache();

    expect(
      await loadPinnedModel(ctx.orgId, model.id, { credentialId: null, source: "org" }),
    ).toBeNull();
    expect(
      await loadPinnedModel(ctx.orgId, "sys-claude", { credentialId: null, source: "org" }),
    ).toBeNull();
    expect(
      await loadPinnedModel(ctx.orgId, "sys-claude", { credentialId: null, source: "system" }),
    ).toMatchObject({ credentialSource: "system" });
    expect(
      await loadPinnedModel(ctx.orgId, alias.id, { credentialId: null, source: "org" }),
    ).toMatchObject({ aliased: true });
  });

  it("a personal credential whose key is not in the keyring is skipped for the org key", async () => {
    const org = await orgAnthropicKey();
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: org.id,
      providerId: "anthropic",
      modelId: ANTHROPIC_A,
      label: "Claude",
    });
    const mine = await personalAnthropicKey(ctx.user.id, "sk-alice");
    // Sealed under a key id this process does not hold.
    const [version, , payload] = mine.credentialsEncrypted.split(":");
    await db
      .update(modelProviderCredentials)
      .set({ credentialsEncrypted: `${version}:unknown-kid:${payload}` })
      .where(eq(modelProviderCredentials.id, mine.id));
    clearResolvedModelCache();

    expect(await loadModel(ctx.orgId, model.id, ctx.user.id)).toMatchObject({
      credentialSource: "org",
      credentialId: org.id,
      apiKey: "sk-org",
    });
    expect(billedTo(await listOrgModels(ctx.orgId, ctx.user.id), model.id)).toBe("org");
  });
});
