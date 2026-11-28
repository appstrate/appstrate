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
import { listOrgModels, loadModel } from "../../../src/services/org-models.ts";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedModelConfigFor, seedOrgModel, seedOrgModelProviderKey } from "../../helpers/seed.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";

getTestApp(); // boots the model registry

// The alias serving checks below need openai and anthropic at their production endpoint.
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

    const listed = (await listOrgModels(ctx.orgId, null)).find((m) => m.id === model.id);
    expect(listed).toBeDefined();
    expect(listed!.aliased).toBe(false);

    const resolved = await loadModel(ctx.orgId, model.id, null);
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

    const listed = (await listOrgModels(ctx.orgId, null)).find((m) => m.id === model.id);
    expect(listed).toBeDefined();
    expect(listed!.aliased).toBe(true);

    const resolved = await loadModel(ctx.orgId, model.id, null);
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
    const listed = (await listOrgModels(ctx.orgId, null)).find((m) => m.id === model.id);
    expect(listed!.generation?.reasoning.levels).toEqual(levels);
    expect((await loadModel(ctx.orgId, model.id, null))!.generation?.reasoning.levels).toEqual(
      levels,
    );
  });
});

describe("org-models — an alias is served by organization connections only", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "aliasorgonly" });
  });

  async function seedAlias(): Promise<{ id: string; configId: string }> {
    const configId = await seedModelConfigFor(ctx.orgId, "openai");
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      configId,
      label: "Appstrate Medium",
      modelId: "gpt-5.5",
      enabled: true,
      aliased: true,
    });
    return { id: model.id, configId };
  }

  const personalKey = (configId: string) =>
    seedOrgModelProviderKey({
      orgId: ctx.orgId,
      providerId: "openai",
      createdBy: ctx.user.id,
      ownerUserId: ctx.user.id,
      label: "Own key",
      apiKey: "sk-personal",
      configId,
    });

  it("resolves nothing for a payer whose only connection is personal", async () => {
    const alias = await seedAlias();
    await personalKey(alias.configId);

    const resolved = await loadModel(ctx.orgId, alias.id, ctx.user.id);
    expect(resolved?.credentialSource ?? null).toBeNull();
  });

  it("resolves the organization connection, though the payer holds a personal one", async () => {
    const alias = await seedAlias();
    await personalKey(alias.configId);
    const org = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      providerId: "openai",
      label: "Org key",
      apiKey: "sk-org",
      configId: alias.configId,
    });

    const resolved = await loadModel(ctx.orgId, alias.id, ctx.user.id);
    expect(resolved).toMatchObject({ credentialSource: "org", credentialId: org.id });
    expect(resolved!.apiKey).toBe("sk-org");
  });
});
