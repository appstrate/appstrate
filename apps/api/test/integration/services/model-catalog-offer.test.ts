// SPDX-License-Identifier: Apache-2.0

/**
 * The live model catalog against the API: what an org can bind once a file is
 * served, and what a system model takes from it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { listPiModels } from "@appstrate/runner-pi/pi-model";
import { getTestApp } from "../../helpers/app.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  catalogFile,
  catalogRecordLike,
  createCatalogSigner,
  type CatalogSigner,
} from "../../helpers/model-catalog.ts";
import { lookupCatalogModel } from "../../../src/services/model-catalog.ts";
import {
  applyModelCatalog,
  readModelCatalog,
} from "../../../src/services/model-catalog-overlay.ts";
import { getModelProvider } from "../../../src/services/model-providers/registry.ts";
import { initSystemModelProviderKeys } from "../../../src/services/model-registry.ts";
import { loadModel } from "../../../src/services/org-models.ts";

const app = getTestApp();
const NEXT = "claude-sonnet-9-next";
const record = catalogRecordLike("anthropic", "claude-sonnet-5-5", "anthropic-messages", NEXT);

describe("live model catalog — what an org and a system model get", () => {
  let signer: CatalogSigner;
  let ctx: TestContext;
  const apply = async (records: unknown[]) => {
    const payload = catalogFile(records);
    applyModelCatalog(
      await readModelCatalog(payload, await signer.sign(payload), signer.publicKey),
    );
  };

  beforeAll(async () => {
    signer = await createCatalogSigner();
  });
  beforeEach(async () => {
    await truncateAll();
    applyModelCatalog(null);
    ctx = await createTestContext();
  });
  afterAll(() => {
    applyModelCatalog(null);
    initSystemModelProviderKeys();
  });

  async function createModel(modelId: string, credentialId: string) {
    return app.request("/api/models", {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({ label: modelId, modelId, credentialId }),
    });
  }

  it("binds a catalog model with its dialect, and loses both when it is withdrawn", async () => {
    const credential = await app.request("/api/model-provider-credentials", {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({ label: "Anthropic", providerId: "anthropic", api_key: "sk-ant-test" }),
    });
    expect(credential.status).toBe(201);
    const credentialId = ((await credential.json()) as { id: string }).id;

    // Not offered yet: a named provider binds only the ids of its offer.
    const refused = async () => {
      const res = await createModel(NEXT, credentialId);
      return { status: res.status, detail: ((await res.json()) as { detail: string }).detail };
    };
    const notOffered = {
      status: 400,
      detail: `Model ${NEXT} is not offered by provider anthropic`,
    };
    expect(await refused()).toEqual(notOffered);

    await apply([record]);

    const created = await createModel(NEXT, credentialId);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const listed = async () => {
      const res = await app.request("/api/models", { headers: authHeaders(ctx) });
      const body = (await res.json()) as { data: Array<Record<string, any>> };
      return body.data.find((m) => m.id === id)!;
    };
    expect(await listed()).toMatchObject({
      modelId: NEXT,
      pi_provider: "anthropic",
      reasoning: record.reasoning,
      contextWindow: record.contextWindow,
      pi_dialect: { name: record.name, compat: record.compat },
    });

    // Withdrawn: the row stays, its record is gone — the same state as an id
    // a Pi bump drops from the bundled registry.
    applyModelCatalog(null);
    expect(await listed()).toMatchObject({ modelId: NEXT, pi_dialect: null });
    expect(await refused()).toEqual(notOffered);
  });

  // OpenRouter takes any id as a system model, so one could name an id only
  // the live catalog records: the platform pays for it, remote data prices nothing.
  it("gives a system model neither price nor dialect from the catalog", async () => {
    const bundled = listPiModels("openrouter", "openai-completions").find((m) => m.cost.input > 0)!;
    const id = "vendor/next-model";
    await apply([catalogRecordLike("openrouter", bundled.id, "openai-completions", id)]);
    expect(lookupCatalogModel(getModelProvider("openrouter")!, id)?.cost).toMatchObject({
      input: bundled.cost.input,
    });

    initSystemModelProviderKeys([
      {
        id: "sys-openrouter",
        providerId: "openrouter",
        apiKey: "sk-system-secret",
        models: [{ id: "m-next", modelId: id }],
      },
    ]);
    expect(await loadModel(ctx.orgId, "m-next", null)).toMatchObject({
      modelId: id,
      credentialSource: "system",
      dialect: null,
      cost: null,
    });
    const res = await app.request("/api/models", { headers: authHeaders(ctx) });
    const { data } = (await res.json()) as { data: Array<Record<string, any>> };
    expect(data.find((m) => m.id === "m-next")).toMatchObject({ pi_dialect: null, cost: null });
  });
});
