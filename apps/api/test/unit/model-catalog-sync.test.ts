// SPDX-License-Identifier: Apache-2.0

/**
 * The live model catalog's channel: what its answer does to the file a process
 * holds in memory.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { ModelProviderDefinition } from "@appstrate/core/module";
import { PI_SDK_VERSION } from "@appstrate/runner-pi/provider-map";
import coreProvidersModule from "../../src/modules/core-providers/index.ts";
import { lookupCatalogModel } from "../../src/services/model-catalog.ts";
import {
  applyModelCatalog,
  heldModelCatalogSerial,
  ModelCatalogRefused,
} from "../../src/services/model-catalog-overlay.ts";
import {
  refreshModelCatalog,
  startModelCatalogSync,
  stopModelCatalogSync,
} from "../../src/services/model-catalog-sync.ts";
import {
  catalogChannel,
  catalogFile,
  catalogRecordLike,
  createCatalogSigner,
  type CatalogSigner,
} from "../helpers/model-catalog.ts";

const anthropic = (coreProvidersModule.modelProviders!() as ModelProviderDefinition[]).find(
  (p) => p.providerId === "anthropic",
)!;
const URL_BASE = "https://catalog.test/model-catalog";
const NEXT = "claude-sonnet-9-next";
const record = catalogRecordLike("anthropic", "claude-sonnet-5-5", "anthropic-messages", NEXT);
const offered = () => lookupCatalogModel(anthropic, NEXT) !== null;

describe("live model catalog — the channel", () => {
  let signer: CatalogSigner;
  let channel: ReturnType<typeof catalogChannel>;
  const options = (over: Record<string, unknown> = {}) => ({
    publicKey: signer.publicKey,
    url: URL_BASE,
    fetch: channel.fetch,
    ...over,
  });

  beforeAll(async () => {
    signer = await createCatalogSigner();
  });
  beforeEach(() => {
    applyModelCatalog(null);
    channel = catalogChannel(signer);
    channel.state.payload = catalogFile([record], { serial: 100 });
  });
  afterAll(() => {
    applyModelCatalog(null);
    stopModelCatalogSync();
  });

  it("serves the channel's file, and reads it again without re-applying it", async () => {
    expect(offered()).toBe(false);
    expect(await refreshModelCatalog(options())).toBe("applied");
    expect(offered()).toBe(true);
    expect(heldModelCatalogSerial()).toBe(100);
    expect(channel.state.requests).toEqual([
      { url: `${URL_BASE}/pi-${PI_SDK_VERSION}.json`, redirect: "error" },
      { url: `${URL_BASE}/pi-${PI_SDK_VERSION}.json.sig`, redirect: "error" },
    ]);

    expect(await refreshModelCatalog(options())).toBe("unchanged");
    expect(offered()).toBe(true);
  });

  it("refuses a file older than the one it holds and keeps what it has", async () => {
    await refreshModelCatalog(options());
    channel.state.payload = catalogFile([], { serial: 99 });
    await expect(refreshModelCatalog(options())).rejects.toThrow(/older than the 100 held/);
    expect(heldModelCatalogSerial()).toBe(100);
    expect(offered()).toBe(true);
  });

  it("refuses a file signed by another key and serves nothing", async () => {
    const other = await createCatalogSigner();
    await expect(refreshModelCatalog(options({ publicKey: other.publicKey }))).rejects.toThrow(
      /signature does not verify/,
    );
    expect(heldModelCatalogSerial()).toBeNull();
  });

  it("refuses a body past the size cap or that is not UTF-8", async () => {
    const serving = (body: Uint8Array) =>
      options({ fetch: (async () => new Response(body)) as unknown as typeof fetch });
    await expect(
      refreshModelCatalog(serving(new Uint8Array(2 * 1024 * 1024 + 1).fill(0x20))),
    ).rejects.toThrow(ModelCatalogRefused);
    await expect(refreshModelCatalog(serving(new Uint8Array([0xff, 0xfe])))).rejects.toThrow();
    expect(heldModelCatalogSerial()).toBeNull();
  });

  it("keeps the file it holds when the channel has none for this Pi version", async () => {
    await refreshModelCatalog(options());
    channel.state.payload = null;
    expect(await refreshModelCatalog(options())).toBe("absent");
    expect(offered()).toBe(true);
  });

  // A newer serial with no record is how a published catalog is withdrawn.
  it("withdraws every model on a newer, empty file", async () => {
    await refreshModelCatalog(options());
    channel.state.payload = catalogFile([], { serial: 101 });
    expect(await refreshModelCatalog(options())).toBe("applied");
    expect(offered()).toBe(false);
  });

  it("keeps the file it holds when the channel is down", async () => {
    await refreshModelCatalog(options());
    const down = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(refreshModelCatalog(options({ fetch: down }))).rejects.toThrow(/ECONNREFUSED/);
    expect(offered()).toBe(true);
  });

  it("reads the channel in the background at start, once, and not at all when switched off", async () => {
    startModelCatalogSync(options({ url: "" }));
    startModelCatalogSync(options());
    startModelCatalogSync(options());
    stopModelCatalogSync();
    // The read was started, not awaited: let it land.
    for (let i = 0; i < 50 && !offered(); i++) await Bun.sleep(10);
    expect(offered()).toBe(true);
    expect(channel.state.requests).toHaveLength(2);
  });

  it("never throws out of the background read when the channel is down", async () => {
    let calls = 0;
    const down = (async () => {
      calls += 1;
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    startModelCatalogSync(options({ fetch: down }));
    stopModelCatalogSync();
    await Bun.sleep(20);
    expect(calls).toBe(1);
    expect(offered()).toBe(false);
  });
});
