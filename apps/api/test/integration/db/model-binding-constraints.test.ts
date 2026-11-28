// SPDX-License-Identifier: Apache-2.0

/**
 * Invariants the model writers hold, stated by the database:
 *   - `model_configs`: one configuration per (org, provider) without an endpoint
 *     (`uq_model_configs_family`), one per (org, provider, endpoint) for a gateway
 *     (`uq_model_configs_endpoint`);
 *   - `org_models`: one non-aliased model per (configuration, model id)
 *     (`uq_org_models_config_model`), deleted with its configuration, never with
 *     a connection;
 *   - `model_provider_pairings`: the owner is the organization or the minter
 *     (`model_provider_pairings_owner_is_minter`), a redeem ends with a
 *     credential or a failure, never both (`model_provider_pairings_outcome_single`),
 *     and only a consumed token fails (`model_provider_pairings_failed_consumed`).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  modelConfigs,
  modelProviderCredentials,
  modelProviderPairings,
  orgModels,
} from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestUser, type TestContext } from "../../helpers/auth.ts";

async function refusal(promise: Promise<unknown>): Promise<string> {
  const caught = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(caught, "the statement was expected to be refused by the database").toBeDefined();
  const cause = (caught as { cause?: { message?: string } }).cause;
  return String(cause?.message ?? caught);
}

let ctx: TestContext;
let credentialId: string;

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "modelbinding" });
  const [credential] = await db
    .insert(modelProviderCredentials)
    .values({
      orgId: ctx.orgId,
      label: "OpenAI",
      providerId: "openai",
      credentialsEncrypted: "v1:k1:opaque",
      createdBy: ctx.user.id,
    })
    .returning({ id: modelProviderCredentials.id });
  credentialId = credential!.id;
});

describe("model_configs — one per family, one per gateway endpoint", () => {
  const config = (providerId: string, baseUrl: string | null = null) =>
    db
      .insert(modelConfigs)
      .values({ orgId: ctx.orgId, providerId, label: providerId, baseUrl })
      .returning({ id: modelConfigs.id });

  it("accepts one family configuration per provider, and gateways on distinct endpoints", async () => {
    await config("anthropic");
    await config("openai-compatible", "https://a.example.test/v1");
    await config("openai-compatible", "https://b.example.test/v1");
  });

  it("refuses a second family configuration of a provider", async () => {
    await config("anthropic");
    expect(await refusal(config("anthropic"))).toContain("uq_model_configs_family");
  });

  it("refuses a second gateway configuration on the same endpoint", async () => {
    await config("openai-compatible", "https://a.example.test/v1");
    expect(await refusal(config("openai-compatible", "https://a.example.test/v1"))).toContain(
      "uq_model_configs_endpoint",
    );
  });
});

describe("org_models — one model id per configuration", () => {
  let configId: string;

  beforeEach(async () => {
    const [row] = await db
      .insert(modelConfigs)
      .values({ orgId: ctx.orgId, providerId: "openai", label: "OpenAI" })
      .returning({ id: modelConfigs.id });
    configId = row!.id;
  });

  const model = (fields: { aliased?: boolean; configId?: string } = {}) =>
    db
      .insert(orgModels)
      .values({ orgId: ctx.orgId, label: "GPT", modelId: "gpt-5", configId, ...fields })
      .returning({ id: orgModels.id });

  it("accepts a model without a credential, and aliases of a model id it already holds", async () => {
    await model();
    await model({ aliased: true });
    await model({ aliased: true });
  });

  it("refuses the same model id twice in a configuration", async () => {
    await model();
    expect(await refusal(model())).toContain("uq_org_models_config_model");
  });

  it("accepts the same model id in another configuration", async () => {
    await model();
    const [other] = await db
      .insert(modelConfigs)
      .values({ orgId: ctx.orgId, providerId: "anthropic", label: "Anthropic" })
      .returning({ id: modelConfigs.id });
    await model({ configId: other!.id });
  });

  it("deletes a configuration's models and connections with it, and lets a connection go alone", async () => {
    const [row] = await model();
    await db
      .update(modelProviderCredentials)
      .set({ configId })
      .where(eq(modelProviderCredentials.id, credentialId));

    // A connection is deleted without its models.
    await db.delete(modelProviderCredentials).where(eq(modelProviderCredentials.id, credentialId));
    expect(await db.select().from(orgModels).where(eq(orgModels.id, row!.id))).toHaveLength(1);

    await db.delete(modelConfigs).where(eq(modelConfigs.id, configId));
    expect(await db.select().from(orgModels).where(eq(orgModels.id, row!.id))).toHaveLength(0);
  });
});

describe("model_provider_pairings — owner and outcome", () => {
  const pairing = (fields: {
    ownerUserId?: string | null;
    consumedAt?: Date | null;
    failedAt?: Date | null;
    credentialId?: string | null;
  }) =>
    db
      .insert(modelProviderPairings)
      .values({
        id: `pair_${crypto.randomUUID()}`,
        tokenHash: crypto.randomUUID(),
        userId: ctx.user.id,
        orgId: ctx.orgId,
        providerId: "openai",
        expiresAt: new Date(Date.now() + 300_000),
        ...fields,
      })
      .returning({ id: modelProviderPairings.id });

  it("accepts an organization pairing, the minter's own, a linked and a failed one", async () => {
    const consumedAt = new Date();
    await pairing({ ownerUserId: null });
    await pairing({ ownerUserId: ctx.user.id });
    await pairing({ consumedAt, credentialId });
    await pairing({ consumedAt, failedAt: new Date() });
  });

  it("refuses a pairing owned by another member than its minter", async () => {
    const other = await createTestUser();
    expect(await refusal(pairing({ ownerUserId: other.id }))).toContain(
      "model_provider_pairings_owner_is_minter",
    );
  });

  it("refuses a redeem that both linked a credential and failed", async () => {
    const [row] = await pairing({ consumedAt: new Date(), credentialId });
    expect(
      await refusal(
        db
          .update(modelProviderPairings)
          .set({ failedAt: new Date() })
          .where(eq(modelProviderPairings.id, row!.id)),
      ),
    ).toContain("model_provider_pairings_outcome_single");
  });

  it("refuses a failure on a token never consumed", async () => {
    expect(await refusal(pairing({ failedAt: new Date() }))).toContain(
      "model_provider_pairings_failed_consumed",
    );
  });
});
