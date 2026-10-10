// SPDX-License-Identifier: Apache-2.0

/**
 * Who pays for a model. A model bound to an organization credential is served by
 * it whoever calls, and a built-in model by the platform key. A member's own
 * credential serves only an unbound model (`credential_id` NULL); with none for
 * the caller it resolves unbound and cannot be spent. Pins the chain in
 * `loadModel`, the LLM proxy's subscription-free chain, a run's launch
 * credential in `loadRunModel`, the write-side invariants, and the `billed_to`
 * listing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { listPiModels } from "@appstrate/runner-pi/pi-model";
import { modelProviderCredentials, orgModels, organizations } from "@appstrate/db/schema";
import type { OrgModelInfo } from "@appstrate/shared-types";
import {
  createOrgModel,
  listOrgModels,
  loadModel,
  loadRunModel,
  requireBoundModel,
  resolveModel,
  setDefaultModel,
} from "../../../src/services/org-models.ts";
import { applicableCredentialIds } from "../../../src/services/model-providers/credential-chain.ts";
import { updateOrgSettings } from "../../../src/services/organizations.ts";
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
import { seedTestModelProviders } from "../../helpers/model-providers.ts";

getTestApp(); // boots the model and provider registries

// The unbound refusals need a production-fixed endpoint on the built-in providers.
beforeAll(() => seedTestModelProviders({ fixedEndpoint: ["openai", "anthropic"] }));
afterAll(() => seedTestModelProviders());

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

describe("model resolution — a member's own credential serves an unbound model", () => {
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

  async function personalKey(userId: string, providerId: string, apiKey: string) {
    const row = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      label: `Personal ${apiKey}`,
      providerId,
      apiKey,
      ownerUserId: userId,
    });
    // The seed bypasses the credential service, which clears the cache on every personal mutation.
    clearResolvedModelCache();
    return row;
  }

  const personalAnthropicKey = (userId: string, apiKey: string) =>
    personalKey(userId, "anthropic", apiKey);

  const unboundModel = (providerId = "anthropic", modelId = ANTHROPIC_A) =>
    createOrgModel(ctx.orgId, "Unbound", modelId, ctx.user.id, { credentialId: null, providerId });

  it("serves a bound org model with its org key to every caller, a holder of a personal key included", async () => {
    const org = await orgAnthropicKey();
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: org.id,
      providerId: "anthropic",
      modelId: ANTHROPIC_A,
      label: "Claude",
    });
    await personalAnthropicKey(ctx.user.id, "sk-alice");

    expect(await loadModel(ctx.orgId, model.id, ctx.user.id)).toMatchObject({
      credentialSource: "org",
      credentialId: org.id,
      apiKey: "sk-org",
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
      credentialSource: "user",
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
      requireBoundModel(model!, bob.user.id);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(409);
    expect((thrown as ApiError).code).toBe("model_credential_required");

    await personalAnthropicKey(bob.user.id, "sk-bob");
    const withKey = await loadModel(ctx.orgId, unbound, bob.user.id);
    expect(requireBoundModel(withKey!, bob.user.id).credentialSource).toBe("user");
  });

  it("ignores personal credentials on an unbound model while the organization has switched them off", async () => {
    const unbound = await unboundModel();
    await personalAnthropicKey(ctx.user.id, "sk-alice");
    await db
      .update(organizations)
      .set({ orgSettings: { personal_model_credentials: false } })
      .where(eq(organizations.id, ctx.orgId));

    expect(await loadModel(ctx.orgId, unbound, ctx.user.id)).toMatchObject({
      credentialSource: null,
      apiKey: "",
    });
  });

  it("gives each of two members their own credential when they resolve the same unbound model concurrently", async () => {
    const model = { id: await unboundModel() };
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

  it("resolves an unbound org default through the payer's own credential", async () => {
    await setDefaultModel(ctx.orgId, await unboundModel());
    await personalAnthropicKey(ctx.user.id, "sk-alice");

    expect(await resolveModel(ctx.orgId, "@acme/agent", null, ctx.user.id)).toMatchObject({
      credentialSource: "user",
      apiKey: "sk-alice",
    });
    expect(await resolveModel(ctx.orgId, "@acme/agent", null, bob.user.id)).toMatchObject({
      credentialSource: null,
      apiKey: "",
    });
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

    expect(await loadModel(ctx.orgId, "sys-claude", ctx.user.id)).toMatchObject({
      credentialSource: "system",
      apiKey: "sk-system",
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
      billed_to: null,
    });
  });

  it("names the payer side per member in billed_to: the org for a bound model, the member's own key for an unbound one", async () => {
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
    // The org binding pays, even for a member holding a personal key of its family.
    expect(billedTo(forAlice, bound.id)).toBe("org");
    expect(billedTo(forAlice, unbound)).toBe("user");

    const forBob = await listOrgModels(ctx.orgId, bob.user.id);
    expect(billedTo(forBob, bound.id)).toBe("org");
    expect(billedTo(forBob, unbound)).toBeNull();

    expect(billedTo(await listOrgModels(ctx.orgId, null), bound.id)).toBe("org");
  });

  it("the LLM proxy's chain skips a personal subscription and serves the member's own API key on an unbound model", async () => {
    const model = { id: await unboundModel("openai", TEST_OAUTH_MODEL_ID) };
    const mine = await personalKey(ctx.user.id, "openai", "sk-alice");
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
      credentialSource: "user",
      credentialId: mine.id,
      apiKey: "sk-alice",
    });
  });

  it("a run's personal credential keeps serving it after the payer adds a subscription", async () => {
    const model = { id: await unboundModel("openai", TEST_OAUTH_MODEL_ID) };
    const mine = await personalKey(ctx.user.id, "openai", "sk-alice");
    const subscription = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: TEST_OAUTH_PROVIDER_ID,
      label: "Alice's subscription",
      ownerUserId: ctx.user.id,
    });
    clearResolvedModelCache();

    // The chain now prefers the subscription; the run launched before it keeps its credential.
    expect(await loadModel(ctx.orgId, model.id, ctx.user.id)).toMatchObject({
      credentialId: subscription.id,
    });
    expect(
      await loadRunModel(ctx.orgId, model.id, { credentialId: mine.id, payerUserId: ctx.user.id }),
    ).toMatchObject({
      credentialSource: "user",
      credentialId: mine.id,
      apiKey: "sk-alice",
    });
  });

  it("a run's personal credential keeps serving it after an admin binds the model to an org key", async () => {
    const model = { id: await unboundModel() };
    const mine = await personalAnthropicKey(ctx.user.id, "sk-alice");
    expect(
      await loadRunModel(ctx.orgId, model.id, { credentialId: mine.id, payerUserId: ctx.user.id }),
    ).toMatchObject({ apiKey: "sk-alice" });

    const org = await orgAnthropicKey();
    await db.update(orgModels).set({ credentialId: org.id }).where(eq(orgModels.id, model.id));
    clearResolvedModelCache();

    expect(await loadModel(ctx.orgId, model.id, ctx.user.id)).toMatchObject({
      apiKey: "sk-org",
    });
    expect(
      await loadRunModel(ctx.orgId, model.id, { credentialId: mine.id, payerUserId: ctx.user.id }),
    ).toMatchObject({
      credentialId: mine.id,
      apiKey: "sk-alice",
    });
  });

  it("a run's personal credential stops serving it once the organization switches personal credentials off", async () => {
    const model = { id: await unboundModel() };
    const mine = await personalAnthropicKey(ctx.user.id, "sk-alice");

    expect(
      await loadRunModel(ctx.orgId, model.id, { credentialId: mine.id, payerUserId: ctx.user.id }),
    ).toMatchObject({
      credentialId: mine.id,
      apiKey: "sk-alice",
    });
    // The policy is switched through the service the routes use, which drops the resolved-model cache.
    await updateOrgSettings(ctx.orgId, { personal_model_credentials: false });
    expect(
      await loadRunModel(ctx.orgId, model.id, { credentialId: mine.id, payerUserId: ctx.user.id }),
    ).toBeNull();
  });

  it("a run whose launch credential is gone resolves its model as it is now, never on another member's key", async () => {
    const org = await orgAnthropicKey();
    const model = { id: await unboundModel() };
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
    // The run launched on a personal key that was then deleted (its id is now null).
    // The launching member and another member still hold keys serving the unbound model.
    await personalAnthropicKey(ctx.user.id, "sk-alice");
    await personalAnthropicKey(bob.user.id, "sk-bob");

    const unbound = await loadRunModel(ctx.orgId, model.id, {
      credentialId: null,
      payerUserId: ctx.user.id,
    });
    expect(unbound).toMatchObject({ credentialSource: null, apiKey: "" });
    let thrown: unknown;
    try {
      requireBoundModel(unbound!, null);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as ApiError).status).toBe(409);
    expect((thrown as ApiError).code).toBe("model_credential_required");

    expect(
      await loadRunModel(ctx.orgId, "sys-claude", { credentialId: null, payerUserId: ctx.user.id }),
    ).toMatchObject({
      credentialSource: "system",
    });
    expect(
      await loadRunModel(ctx.orgId, alias.id, { credentialId: null, payerUserId: ctx.user.id }),
    ).toMatchObject({ aliased: true });
    // An org credential id resolves the model as it is now, too.
    expect(
      await loadRunModel(ctx.orgId, alias.id, { credentialId: org.id, payerUserId: ctx.user.id }),
    ).toMatchObject({
      credentialId: org.id,
      apiKey: "sk-org",
    });
  });

  it("a personal credential whose key is not in the keyring is skipped for the member's next one", async () => {
    const model = { id: await unboundModel() };
    const mine = await personalAnthropicKey(ctx.user.id, "sk-alice");
    // Sealed under a key id this process does not hold.
    const [version, , payload] = mine.credentialsEncrypted.split(":");
    await db
      .update(modelProviderCredentials)
      .set({ credentialsEncrypted: `${version}:unknown-kid:${payload}` })
      .where(eq(modelProviderCredentials.id, mine.id));
    const next = await personalAnthropicKey(ctx.user.id, "sk-alice-next");

    expect(await loadModel(ctx.orgId, model.id, ctx.user.id)).toMatchObject({
      credentialSource: "user",
      credentialId: next.id,
      apiKey: "sk-alice-next",
    });
    expect(billedTo(await listOrgModels(ctx.orgId, ctx.user.id), model.id)).toBe("user");
  });
});
