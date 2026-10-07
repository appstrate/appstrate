// SPDX-License-Identifier: Apache-2.0

/**
 * The org default model is never a disabled model. Two writes can break that —
 * disabling the default, and pointing the default at a disabled model — and
 * each refuses with `409 model_disabled`. Both decisions are taken under the
 * same `org_models` row lock, so a disable and a set-default racing on one
 * model cannot both succeed.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { orgModels, organizations } from "@appstrate/db/schema";
import { setDefaultModel, updateOrgModel } from "../../../src/services/org-models.ts";
// Imported for its module-level boot: `setDefaultModel` and `listOrgModels`
// read the model and provider registries only the app helper initialises.
import "../../helpers/app.ts";
import { ApiError } from "../../../src/lib/errors.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedOrgModel, seedOrgModelProviderKey } from "../../helpers/seed.ts";
import { describeRequiresPostgres } from "../../helpers/tier.ts";

describe("org-models — the default model is never disabled", () => {
  let ctx: TestContext;
  let modelId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "defaultguardorg" });
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
      label: "GPT-4o",
      modelId: "gpt-4o",
      enabled: true,
    });
    modelId = model.id;
  });

  async function readState(): Promise<{ defaultModelId: string | null; enabled: boolean }> {
    const [org] = await db
      .select({ defaultModelId: organizations.defaultModelId })
      .from(organizations)
      .where(eq(organizations.id, ctx.orgId));
    const [row] = await db
      .select({ enabled: orgModels.enabled })
      .from(orgModels)
      .where(eq(orgModels.id, modelId));
    return { defaultModelId: org!.defaultModelId, enabled: row!.enabled };
  }

  function expectModelDisabled(err: unknown): void {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe("model_disabled");
  }

  it("refuses to disable the model set as default", async () => {
    await setDefaultModel(ctx.orgId, modelId);

    const err = await updateOrgModel(ctx.orgId, modelId, { enabled: false }).catch(
      (e: unknown) => e,
    );

    expectModelDisabled(err);
    expect(await readState()).toEqual({ defaultModelId: modelId, enabled: true });
  });

  it("refuses to set a disabled model as default", async () => {
    await updateOrgModel(ctx.orgId, modelId, { enabled: false });

    const err = await setDefaultModel(ctx.orgId, modelId).catch((e: unknown) => e);

    expectModelDisabled(err);
    expect(await readState()).toEqual({ defaultModelId: null, enabled: false });
  });

  // Two transactions waiting on one row lock need two DB sessions — external
  // PostgreSQL only (PGlite is single-connection).
  describeRequiresPostgres("concurrent disable and set-default", () => {
    it("exactly one of the two succeeds; the other is refused with model_disabled", async () => {
      for (let i = 0; i < 10; i++) {
        await db.update(orgModels).set({ enabled: true }).where(eq(orgModels.id, modelId));
        await db
          .update(organizations)
          .set({ defaultModelId: null })
          .where(eq(organizations.id, ctx.orgId));

        const outcomes = await Promise.allSettled([
          updateOrgModel(ctx.orgId, modelId, { enabled: false }),
          setDefaultModel(ctx.orgId, modelId),
        ]);

        const rejected = outcomes.filter((o) => o.status === "rejected");
        expect(rejected).toHaveLength(1);
        expectModelDisabled((rejected[0] as PromiseRejectedResult).reason);

        const state = await readState();
        expect(state.defaultModelId === modelId && !state.enabled).toBe(false);
      }
    });
  });
});
