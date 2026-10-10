// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import {
  clearResolvedModelCache,
  resolveModelCached,
} from "../../../src/services/resolved-model-cache.ts";
import type { ResolvedModel } from "../../../src/services/org-models.ts";

function countingLoader(value: ResolvedModel | null) {
  const loader = {
    calls: 0,
    run: async () => {
      loader.calls++;
      return value;
    },
  };
  return loader;
}

const MODEL = { providerId: "openai" } as unknown as ResolvedModel;

describe("resolveModelCached", () => {
  beforeEach(() => {
    clearResolvedModelCache();
  });

  it("serves a repeated payer resolution from the cache", async () => {
    const loaderA = countingLoader(MODEL);
    const slot = { kind: "payer", payerUserId: "u", viaProxy: false } as const;

    await resolveModelCached("o", "m", slot, loaderA.run);
    await resolveModelCached("o", "m", slot, loaderA.run);

    expect(loaderA.calls).toBe(1);
  });

  it("keys a payer resolution by viaProxy: the proxy chain never shares a subscription entry", async () => {
    const direct = countingLoader(MODEL);
    const proxy = countingLoader(MODEL);

    await resolveModelCached(
      "o",
      "m",
      { kind: "payer", payerUserId: "u", viaProxy: false },
      direct.run,
    );
    await resolveModelCached(
      "o",
      "m",
      { kind: "payer", payerUserId: "u", viaProxy: true },
      proxy.run,
    );

    expect(direct.calls).toBe(1);
    expect(proxy.calls).toBe(1);
  });

  it("keys a run resolution by payer: two members never share an entry", async () => {
    const u1 = countingLoader(MODEL);
    const u2 = countingLoader(MODEL);

    await resolveModelCached(
      "o",
      "m",
      { kind: "run", credentialId: "c", payerUserId: "u1" },
      u1.run,
    );
    await resolveModelCached(
      "o",
      "m",
      { kind: "run", credentialId: "c", payerUserId: "u2" },
      u2.run,
    );

    expect(u1.calls).toBe(1);
    expect(u2.calls).toBe(1);
  });

  it("answers null without storing it, so the next call loads again", async () => {
    const loader = countingLoader(null);
    const slot = { kind: "payer", payerUserId: null, viaProxy: false } as const;

    expect(await resolveModelCached("o", "m", slot, loader.run)).toBeNull();
    expect(await resolveModelCached("o", "m", slot, loader.run)).toBeNull();

    expect(loader.calls).toBe(2);
  });
});
