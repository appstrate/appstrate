// SPDX-License-Identifier: Apache-2.0

/**
 * Verifies the catalog (Pi's registry) acts as fallback for `loadModel()`
 * when `org_models.cost` (the per-org override) is null, and that an
 * explicit override still wins over the catalog.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { buildPiModel, piReasoningLevels } from "@appstrate/runner-pi/pi-model";
import { piReasoningOff } from "@appstrate/runner-pi/pi-reasoning-off";
import { listOrgModels, loadModel } from "../../../src/services/org-models.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedOrgModel, seedOrgModelProviderKey } from "../../helpers/seed.ts";

describe("loadModel — catalog fallback", () => {
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
    // Custom fine-tune / model id the catalog does not know.
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

  it("fills contextWindow / maxTokens / input / reasoning from catalog when the org row stores null", async () => {
    // Same rationale as the cost fallback: storing nulls on `org_models`
    // means a Pi registry bump propagates to existing rows. `buildDbResolvedModel` resolves all five fields via
    // the same `resolveCatalogDefaults` path.
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
      label: "GPT-4o catalog",
      modelId: "gpt-4o",
      enabled: true,
      cost: null,
      // Drizzle column is nullable — leave the four catalog-derivable
      // fields out so the resolver picks them up live from the catalog.
    });
    const resolved = await loadModel(ctx.orgId, model.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.contextWindow).toBeGreaterThan(0);
    expect(resolved!.input).toContain("text");
    expect(resolved!.reasoning === false || resolved!.reasoning === null).toBe(true);
  });

  it("resolves the Pi provider key once, null for a gateway", async () => {
    const piProviderOf = async (providerId: string, modelId: string) => {
      const cred = await seedOrgModelProviderKey({
        orgId: ctx.orgId,
        providerId,
        apiShape: "openai-completions",
        apiKey: "sk-test",
      });
      const model = await seedOrgModel({ orgId: ctx.orgId, credentialId: cred.id, modelId });
      return (await loadModel(ctx.orgId, model.id))!.piProvider;
    };
    expect(await piProviderOf("moonshot", "kimi-k2.6")).toBe("moonshotai");
    expect(await piProviderOf("openai-compatible", "my-model")).toBeNull();
  });

  const OPENROUTER_URL = "https://openrouter.ai/api/v1";

  it("says what `off` sends for a model outside the registry, from the model a run builds", async () => {
    const offOf = async (
      providerId: string,
      modelId: string,
      reasoning: boolean,
      baseUrl?: string,
    ) => {
      const cred = await seedOrgModelProviderKey({
        orgId: ctx.orgId,
        providerId,
        apiKey: "sk-test",
        ...(baseUrl ? { baseUrl } : {}),
      });
      const model = await seedOrgModel({
        orgId: ctx.orgId,
        credentialId: cred.id,
        modelId,
        reasoning,
      });
      const resolved = (await loadModel(ctx.orgId, model.id))!;
      if (baseUrl) expect(resolved.baseUrl).toBe(baseUrl);
      const generation = resolved.generation?.reasoning;
      const listed = (await listOrgModels(ctx.orgId)).find((m) => m.id === model.id)!.generation
        ?.reasoning;
      expect(listed).toEqual(generation!);
      // The model the runner builds from a non-aliased binding (`runtime-pi/env.ts`):
      // its `MODEL_BASE_URL` is the sidecar's LLM proxy, never the upstream.
      const run = buildPiModel({
        id: resolved.modelId,
        dialect: resolved.dialect,
        apiShape: resolved.apiShape,
        piProvider: resolved.piProvider,
        baseUrl: "http://sidecar:8080/llm",
        reasoning: resolved.reasoning,
      });
      expect(generation?.off).toBe(piReasoningOff(run)!);
      const levels = piReasoningLevels(run);
      expect(
        Object.keys(generation!.levels).filter(
          (l) => generation!.levels[l as never] === "supported",
        ),
      ).toEqual(levels);
      return generation;
    };
    // A gateway's openai-completions sends no reasoning parameter at `off`;
    // Anthropic disables thinking.
    expect((await offOf("openai-compatible", "my-model", true))?.off).toBe("unsent");
    expect((await offOf("anthropic-compatible", "my-model", true))?.off).toBe("disables");
    expect(await offOf("openai-compatible", "my-model", false)).not.toHaveProperty("off");
    // A non-aliased model's Pi never sees the gateway's upstream host, so
    // OpenRouter's endpoint alone does not switch it to OpenRouter's dialect.
    const viaOpenRouter = await offOf("openai-compatible", "my-model", true, OPENROUTER_URL);
    expect(viaOpenRouter?.off).toBe("unsent");
    // OpenRouter is searched live, so it serves ids its registry lacks: Pi still
    // speaks its dialect there, which sends `reasoning: { effort: "none" }`.
    expect((await offOf("openrouter", "vendor/unlisted-model", true))?.off).toBe("disables");
  });

  // Regression for #544: `org_models.id` is a uuid column. A non-UUID id (e.g.
  // a human-readable model name) used to make Postgres throw
  // `invalid input syntax for type uuid`, surfacing as a 500. loadModel now
  // swallows the cast failure and resolves null ("not found").
  it("returns null (no throw) for a non-UUID modelDbId", async () => {
    const resolved = await loadModel(ctx.orgId, "gpt-5.5");
    expect(resolved).toBeNull();
  });
});
