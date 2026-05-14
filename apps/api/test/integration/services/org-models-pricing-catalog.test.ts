// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 2 of #437 — verifies the catalog acts as fallback for
 * `loadModel()` when `org_models.cost` (the per-org override) is null,
 * and that an explicit override still wins over the catalog.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { loadModel } from "../../../src/services/org-models.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedOrgModel, seedOrgModelProviderKey } from "../../helpers/seed.ts";

describe("loadModel — vendored pricing catalog fallback (#437 phase 2)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "pricingorg" });
  });

  it("fills cost from the catalog when the org row has no override (gpt-4o)", async () => {
    const cred = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      label: "OpenAI",
      apiShape: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });
    // `cost: null` is the new default once we drop the JSONB from the
    // form — the catalog should kick in.
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: cred.id,
      label: "GPT-4o preset",
      modelId: "gpt-4o",
      enabled: true,
      cost: null,
    });
    const resolved = await loadModel(ctx.orgId, model.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.cost).not.toBeNull();
    // Sanity check the canonical numbers — the catalog ships gpt-4o at
    // $2.50/M input, $10/M output.
    expect(resolved!.cost!.input).toBeCloseTo(2.5, 4);
    expect(resolved!.cost!.output).toBeCloseTo(10, 4);
  });

  it("respects an explicit per-org cost override even when the catalog has an entry", async () => {
    const cred = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      label: "OpenAI",
      apiShape: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: cred.id,
      label: "GPT-4o with org discount",
      modelId: "gpt-4o",
      enabled: true,
      // Hypothetical enterprise discount — half the public list price.
      cost: { input: 1.25, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
    const resolved = await loadModel(ctx.orgId, model.id);
    expect(resolved!.cost!.input).toBeCloseTo(1.25, 4);
    expect(resolved!.cost!.output).toBeCloseTo(5, 4);
  });

  it("returns null cost when neither override nor catalog has an entry", async () => {
    // Custom fine-tune / model id that won't be in the vendored snapshot.
    const cred = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      label: "OpenAI",
      apiShape: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: cred.id,
      label: "Custom fine-tune",
      modelId: "ft:gpt-4o:my-org:custom:xyz123",
      enabled: true,
      cost: null,
    });
    const resolved = await loadModel(ctx.orgId, model.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.cost).toBeNull();
  });
});
