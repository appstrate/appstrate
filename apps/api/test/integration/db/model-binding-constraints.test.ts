// SPDX-License-Identifier: Apache-2.0

/**
 * Invariants the model writers hold, stated by the database:
 *   - `org_models`: an alias is bound to a credential (`org_models_alias_bound`),
 *     and a bound model's provider is its credential's
 *     (`org_models_credential_provider_fk`, which keeps ON DELETE RESTRICT);
 *   - `model_provider_pairings`: the owner is the organization or the minter
 *     (`model_provider_pairings_owner_is_minter`), a redeem ends with a
 *     credential or a failure, never both (`model_provider_pairings_outcome_single`),
 *     and only a consumed token fails (`model_provider_pairings_failed_consumed`).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials, modelProviderPairings, orgModels } from "@appstrate/db/schema";
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

describe("org_models — binding", () => {
  const model = (fields: { providerId: string; credentialId: string | null; aliased?: boolean }) =>
    db
      .insert(orgModels)
      .values({ orgId: ctx.orgId, label: "GPT", modelId: "gpt-5", ...fields })
      .returning({ id: orgModels.id });

  it("accepts a model bound to a credential of its provider, an alias among them", async () => {
    await model({ providerId: "openai", credentialId });
    await model({ providerId: "openai", credentialId, aliased: true });
  });

  it("accepts an unbound model of any provider", async () => {
    await model({ providerId: "anthropic", credentialId: null });
  });

  it("refuses an unbound alias", async () => {
    expect(
      await refusal(model({ providerId: "openai", credentialId: null, aliased: true })),
    ).toContain("org_models_alias_bound");
  });

  it("refuses unbinding an alias", async () => {
    const [row] = await model({ providerId: "openai", credentialId, aliased: true });
    expect(
      await refusal(
        db.update(orgModels).set({ credentialId: null }).where(eq(orgModels.id, row!.id)),
      ),
    ).toContain("org_models_alias_bound");
  });

  it("refuses a bound model whose provider is not its credential's", async () => {
    expect(await refusal(model({ providerId: "anthropic", credentialId }))).toContain(
      "org_models_credential_provider_fk",
    );
  });

  it("refuses moving a bound model to another provider", async () => {
    const [row] = await model({ providerId: "openai", credentialId });
    expect(
      await refusal(
        db.update(orgModels).set({ providerId: "anthropic" }).where(eq(orgModels.id, row!.id)),
      ),
    ).toContain("org_models_credential_provider_fk");
  });

  it("refuses rewriting the provider of a credential a model is bound to", async () => {
    await model({ providerId: "openai", credentialId });
    expect(
      await refusal(
        db
          .update(modelProviderCredentials)
          .set({ providerId: "anthropic" })
          .where(eq(modelProviderCredentials.id, credentialId)),
      ),
    ).toContain("org_models_credential_provider_fk");
  });

  it("still refuses deleting a credential a model references", async () => {
    await model({ providerId: "openai", credentialId });
    expect(
      await refusal(
        db.delete(modelProviderCredentials).where(eq(modelProviderCredentials.id, credentialId)),
      ),
    ).toContain("org_models_credential_provider_fk");
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
