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

import { describe, it, expect, beforeEach } from "bun:test";
import { listOrgModels, loadModel } from "../../../src/services/org-models.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedOrgModel, seedOrgModelProviderKey } from "../../helpers/seed.ts";

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
      label: "Plain GPT-4o",
      modelId: "gpt-4o",
      enabled: true,
    });

    const listed = (await listOrgModels(ctx.orgId)).find((m) => m.id === model.id);
    expect(listed).toBeDefined();
    expect(listed!.aliased).toBe(false);

    const resolved = await loadModel(ctx.orgId, model.id);
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
      label: "Appstrate Medium",
      modelId: "gpt-4o", // the hidden backing
      enabled: true,
      aliased: true,
    });

    const listed = (await listOrgModels(ctx.orgId)).find((m) => m.id === model.id);
    expect(listed).toBeDefined();
    expect(listed!.aliased).toBe(true);

    const resolved = await loadModel(ctx.orgId, model.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.aliased).toBe(true);
    // The user-selected alias is the row id; the real backing is hidden behind it.
    expect(resolved!.aliasId).toBe(model.id);
    expect(resolved!.modelId).toBe("gpt-4o");
  });
});
