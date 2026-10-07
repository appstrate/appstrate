// SPDX-License-Identifier: Apache-2.0

/**
 * The live model catalog against a database: what the channel's answer does to
 * the stored file, what a second replica reads back, and what an org and a
 * system model then get.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { modelCatalogOverlays } from "@appstrate/db/schema";
import { listPiModels } from "@appstrate/runner-pi/pi-model";
import { PI_SDK_VERSION } from "@appstrate/runner-pi/provider-map";
import { getTestApp } from "../../helpers/app.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  catalogChannel,
  catalogFile,
  catalogRecordLike,
  createCatalogSigner,
  type CatalogSigner,
} from "../../helpers/model-catalog.ts";
import { lookupCatalogModel } from "../../../src/services/model-catalog.ts";
import {
  applyModelCatalog,
  ModelCatalogRefused,
  readModelCatalog,
} from "../../../src/services/model-catalog-overlay.ts";
import {
  fetchModelCatalog,
  loadStoredModelCatalog,
  stopModelCatalogSync,
  syncModelCatalog,
} from "../../../src/services/model-catalog-sync.ts";
import { getModelProvider } from "../../../src/services/model-providers/registry.ts";
import { initSystemModelProviderKeys } from "../../../src/services/model-registry.ts";
import { loadModel } from "../../../src/services/org-models.ts";

const app = getTestApp();
const URL_BASE = "https://catalog.test/model-catalog";
const NEXT = "claude-sonnet-9-next";
const record = catalogRecordLike("anthropic", "claude-sonnet-5-5", "anthropic-messages", NEXT);
const offered = () => lookupCatalogModel(getModelProvider("anthropic")!, NEXT) !== null;
const rows = () => db.select().from(modelCatalogOverlays);
const ownRow = eq(modelCatalogOverlays.sdkVersion, PI_SDK_VERSION);
const HOUR = 60 * 60_000;

describe("live model catalog — storage and sync", () => {
  let signer: CatalogSigner;
  let channel: ReturnType<typeof catalogChannel>;
  const options = (over: Record<string, unknown> = {}) => ({
    publicKey: signer.publicKey,
    url: URL_BASE,
    fetch: channel.fetch,
    ...over,
  });
  /** A process that starts now: nothing applied, nothing remembered. */
  const restart = () => {
    applyModelCatalog(null);
    stopModelCatalogSync();
  };

  beforeAll(async () => {
    signer = await createCatalogSigner();
  });
  beforeEach(async () => {
    await truncateAll();
    restart();
    channel = catalogChannel(signer);
    channel.state.payload = catalogFile([record], { serial: 100 });
  });
  afterAll(restart);

  it("stores the channel's file byte for byte, then serves it", async () => {
    expect(await fetchModelCatalog(options())).toBe("stored");
    expect(await rows()).toMatchObject([
      {
        sdkVersion: PI_SDK_VERSION,
        serial: 100,
        payload: channel.state.payload,
        signature: await signer.sign(channel.state.payload!),
      },
    ]);
    expect(channel.state.requests).toEqual([
      { url: `${URL_BASE}/pi-${PI_SDK_VERSION}.json`, redirect: "error" },
      { url: `${URL_BASE}/pi-${PI_SDK_VERSION}.json.sig`, redirect: "error" },
    ]);

    // Stored is not served: a process serves what it read back from the row.
    expect(offered()).toBe(false);
    expect(await loadStoredModelCatalog(options())).toBeInstanceOf(Date);
    expect(offered()).toBe(true);
  });

  it("refuses a file older than the stored one and keeps what it has", async () => {
    await syncModelCatalog(options());
    channel.state.payload = catalogFile([], { serial: 99 });

    await expect(fetchModelCatalog(options())).rejects.toThrow(ModelCatalogRefused);
    expect(await rows()).toMatchObject([{ serial: 100 }]);
    await loadStoredModelCatalog(options());
    expect(offered()).toBe(true);
  });

  // A serial names one file.
  it("refuses other bytes under the stored serial, and takes the same file again", async () => {
    await fetchModelCatalog(options());
    const stored = channel.state.payload;
    channel.state.payload = catalogFile([], { serial: 100 });
    await expect(fetchModelCatalog(options())).rejects.toThrow(/does not follow the stored/);
    expect(await rows()).toMatchObject([{ payload: stored }]);

    channel.state.payload = stored;
    await db.update(modelCatalogOverlays).set({ checkedAt: new Date(Date.now() - 7 * HOUR) });
    expect(await fetchModelCatalog(options())).toBe("stored");
    expect(Date.now() - (await rows())[0]!.checkedAt.getTime()).toBeLessThan(60_000);
  });

  it("ends on the newest file whatever order two replicas write in", async () => {
    const newer = catalogChannel(signer);
    newer.state.payload = catalogFile([], { serial: 101 });
    for (const order of [
      [channel, newer],
      [newer, channel],
    ]) {
      await db.delete(modelCatalogOverlays);
      await Promise.allSettled(order.map((c) => fetchModelCatalog(options({ fetch: c.fetch }))));
      expect(await rows()).toMatchObject([{ serial: 101 }]);
    }
  });

  it("refuses a file signed by another key and stores nothing", async () => {
    const other = await createCatalogSigner();
    await expect(fetchModelCatalog(options({ publicKey: other.publicKey }))).rejects.toThrow(
      /signature does not verify/,
    );
    expect(await rows()).toEqual([]);
  });

  it("refuses a body past the size cap or that is not UTF-8, and stores nothing", async () => {
    const serving = (body: Uint8Array) =>
      options({ fetch: (async () => new Response(body)) as unknown as typeof fetch });
    await expect(
      fetchModelCatalog(serving(new Uint8Array(2 * 1024 * 1024 + 1).fill(0x20))),
    ).rejects.toThrow(/larger than/);
    await expect(fetchModelCatalog(serving(new Uint8Array([0xff, 0xfe])))).rejects.toThrow();
    expect(await rows()).toEqual([]);
  });

  it("keeps the stored file when the channel has none for this Pi version", async () => {
    await syncModelCatalog(options());
    channel.state.payload = null;
    expect(await fetchModelCatalog(options())).toBe("absent");
    await loadStoredModelCatalog(options());
    expect(await rows()).toHaveLength(1);
    expect(offered()).toBe(true);
  });

  // A newer serial with no record is how a published catalog is withdrawn.
  it("withdraws every model on a newer, empty file", async () => {
    await syncModelCatalog(options());
    expect(offered()).toBe(true);
    channel.state.payload = catalogFile([], { serial: 101 });
    await fetchModelCatalog(options());
    await loadStoredModelCatalog(options());
    expect(offered()).toBe(false);
  });

  // Replicas of two Pi versions share the table during a rolling deploy.
  it("leaves another Pi version its row until nobody confirms it any more", async () => {
    const other = { serial: 1, payload: "{}", signature: "x" };
    await db.insert(modelCatalogOverlays).values([
      { ...other, sdkVersion: "0.0.1", checkedAt: new Date(Date.now() - 24 * HOUR) },
      { ...other, sdkVersion: "0.0.2", checkedAt: new Date(Date.now() - 31 * 24 * HOUR) },
    ]);
    await fetchModelCatalog(options());
    expect((await rows()).map((r) => r.sdkVersion).sort()).toEqual(["0.0.1", PI_SDK_VERSION]);
  });

  it("lets a second replica serve the stored file, verified again", async () => {
    await fetchModelCatalog(options());
    await loadStoredModelCatalog(options());
    expect(offered()).toBe(true);

    // A row that no longer verifies is not trusted for having been stored.
    restart();
    await db
      .update(modelCatalogOverlays)
      .set({ payload: channel.state.payload!.replace(NEXT, "claude-sonnet-9-evil") })
      .where(ownRow);
    expect(await loadStoredModelCatalog(options())).toBeNull();
    expect(lookupCatalogModel(getModelProvider("anthropic")!, "claude-sonnet-9-evil")).toBeNull();
    expect(offered()).toBe(false);

    // The next pass asks the channel whatever the row's age, and the row heals.
    await syncModelCatalog(options());
    expect(await rows()).toMatchObject([{ payload: channel.state.payload }]);
    expect(offered()).toBe(true);
  });

  it("is switched off by an empty URL: no request, no model, the row untouched", async () => {
    await syncModelCatalog(options());
    const requests = channel.state.requests.length;

    restart();
    await syncModelCatalog(options({ url: "" }));
    expect(channel.state.requests).toHaveLength(requests);
    expect(offered()).toBe(false);
    expect(await rows()).toHaveLength(1);
  });

  it("asks the channel only when its last answer is stale", async () => {
    await syncModelCatalog(options());
    expect(offered()).toBe(true);
    expect(channel.state.requests).toHaveLength(2);

    // Fresh: another replica's pass serves the row and leaves the channel alone.
    restart();
    await syncModelCatalog(options());
    expect(offered()).toBe(true);
    expect(channel.state.requests).toHaveLength(2);

    // Stale: the next pass asks again.
    await db.update(modelCatalogOverlays).set({ checkedAt: new Date(Date.now() - 7 * HOUR) });
    await syncModelCatalog(options());
    expect(channel.state.requests).toHaveLength(4);
    expect(Date.now() - (await rows())[0]!.checkedAt.getTime()).toBeLessThan(60_000);
  });

  it("never throws out of a pass when the channel is down, and waits before asking again", async () => {
    let calls = 0;
    const down = (async () => {
      calls += 1;
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    await syncModelCatalog(options({ fetch: down }));
    await syncModelCatalog(options({ fetch: down }));
    expect(calls).toBe(1);
    expect(offered()).toBe(false);
  });
});

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
    expect(await loadModel(ctx.orgId, "m-next")).toMatchObject({
      modelId: id,
      isSystemModel: true,
      dialect: null,
      cost: null,
    });
    const res = await app.request("/api/models", { headers: authHeaders(ctx) });
    const { data } = (await res.json()) as { data: Array<Record<string, any>> };
    expect(data.find((m) => m.id === "m-next")).toMatchObject({ pi_dialect: null, cost: null });
  });
});
