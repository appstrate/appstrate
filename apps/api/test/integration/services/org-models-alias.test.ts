// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1 (model alias) — DB-row path. The `org_models.aliased` flag must:
 *  - default to false on a plain row,
 *  - round-trip through `listOrgModels` (the wire projection carries it), and
 *  - reach the resolved-model shape consumed by the run executor, exposing both
 *    the public `aliasId` (the row id the user selected) and the real `modelId`
 *    (kept server-side for the sidecar swap + private usage ledger).
 *
 * The Phase-2 list projection (stripping the real binding) and the Phase-3
 * sidecar swap build on the flag landing correctly here.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { listOrgModels, loadModel, updateOrgModel } from "../../../src/services/org-models.ts";
import { ApiError } from "../../../src/lib/errors.ts";
import { orgModels } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedOrgModel, seedOrgModelProviderKey } from "../../helpers/seed.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import { NO_PAYER } from "../../../src/services/model-providers/payer.ts";

getTestApp(); // boots the model registry

// The unbind and alias races below need openai and anthropic at their production endpoint.
beforeAll(() => seedTestModelProviders({ fixedEndpoint: ["openai", "anthropic"] }));
afterAll(() => seedTestModelProviders());

describe("org-models — aliased flag (DB path)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "aliasorg" });
  });

  async function seedCred() {
    return seedOrgModelProviderKey({
      orgId: ctx.orgId,
      label: "OpenAI",
      apiShape: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });
  }

  it("defaults aliased to false for a plain row and carries it through list + resolve", async () => {
    const cred = await seedCred();
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: cred.id,
      providerId: cred.providerId,
      label: "Plain GPT-4o",
      modelId: "gpt-4o",
      enabled: true,
    });

    const listed = (await listOrgModels(ctx.orgId, NO_PAYER)).find((m) => m.id === model.id);
    expect(listed).toBeDefined();
    expect(listed!.aliased).toBe(false);

    const resolved = await loadModel(ctx.orgId, model.id, NO_PAYER);
    expect(resolved).not.toBeNull();
    expect(resolved!.aliased).toBe(false);
    // Non-aliased: alias id and real model id describe the same model.
    expect(resolved!.aliasId).toBe(model.id);
    expect(resolved!.modelId).toBe("gpt-4o");
  });

  it("surfaces aliased=true through list and exposes aliasId + real modelId on resolve", async () => {
    const cred = await seedCred();
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: cred.id,
      providerId: cred.providerId,
      label: "Appstrate Medium",
      modelId: "gpt-4o", // the hidden backing
      enabled: true,
      aliased: true,
    });

    const listed = (await listOrgModels(ctx.orgId, NO_PAYER)).find((m) => m.id === model.id);
    expect(listed).toBeDefined();
    expect(listed!.aliased).toBe(true);

    const resolved = await loadModel(ctx.orgId, model.id, NO_PAYER);
    expect(resolved).not.toBeNull();
    expect(resolved!.aliased).toBe(true);
    // The user-selected alias is the row id; the real backing is hidden behind it.
    expect(resolved!.aliasId).toBe(model.id);
    expect(resolved!.modelId).toBe("gpt-4o");
  });

  it("gives an alias its public level set on every internal surface, not its backing's", async () => {
    const cred = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      providerId: "deepseek",
      apiShape: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
    });
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: cred.id,
      providerId: cred.providerId,
      modelId: "deepseek-flash", // takes off/low/high/max
      aliased: true,
    });
    const levels = {
      off: "supported",
      minimal: "supported",
      low: "supported",
      medium: "supported",
      high: "supported",
    } as const;
    const listed = (await listOrgModels(ctx.orgId, NO_PAYER)).find((m) => m.id === model.id);
    expect(listed!.generation?.reasoning.levels).toEqual(levels);
    expect((await loadModel(ctx.orgId, model.id, NO_PAYER))!.generation?.reasoning.levels).toEqual(
      levels,
    );
  });
});

describe("org-models — the alias invariant on the locked row", () => {
  let ctx: TestContext;
  let modelId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "aliaslockorg" });
    const key = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      label: "OpenAI",
      apiShape: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: key.id,
      providerId: key.providerId,
      label: "Plain",
      modelId: "gpt-4o",
      enabled: true,
    });
    modelId = model.id;
  });

  async function storedBinding() {
    const [row] = await db
      .select({ aliased: orgModels.aliased, credentialId: orgModels.credentialId })
      .from(orgModels)
      .where(eq(orgModels.id, modelId));
    return row!;
  }

  it("never leaves an alias unbound when an unbind and an alias race on the same row", async () => {
    const providerId = "openai";
    const results = await Promise.allSettled([
      updateOrgModel(ctx.orgId, modelId, { credentialId: null, providerId }),
      updateOrgModel(ctx.orgId, modelId, { aliased: true, label: "Masked" }),
    ]);

    // Whichever commits first, the other one sees its effect on the locked row and is refused.
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ApiError);
    expect(((rejected[0] as PromiseRejectedResult).reason as ApiError).status).toBe(400);

    const row = await storedBinding();
    expect(row.aliased === true && row.credentialId === null).toBe(false);
  });

  it("refuses an alias once the model is unbound, and admits it while still bound", async () => {
    // Control: the alias is legal while the row keeps its organization credential.
    await updateOrgModel(ctx.orgId, modelId, { aliased: true, label: "Masked" });
    expect(await storedBinding()).toMatchObject({ aliased: true });
    await updateOrgModel(ctx.orgId, modelId, { aliased: false });

    await updateOrgModel(ctx.orgId, modelId, { credentialId: null, providerId: "openai" });
    const error = await updateOrgModel(ctx.orgId, modelId, { aliased: true }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect(await storedBinding()).toMatchObject({ aliased: false, credentialId: null });
  });
});
