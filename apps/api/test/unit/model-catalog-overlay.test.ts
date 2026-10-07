// SPDX-License-Identifier: Apache-2.0

/**
 * The live model catalog: what a file must be for an instance to accept it,
 * which of its records the pinned Pi code may serve, and what the offer
 * becomes once it is applied.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { ModelProviderDefinition } from "@appstrate/core/module";
import { PLATFORM_MODEL_COMPAT } from "@appstrate/runner-pi/model-compat";
import { buildPiModel, getPiModel } from "@appstrate/runner-pi/pi-model";
import { PI_SDK_VERSION } from "@appstrate/runner-pi/provider-map";
import coreProvidersModule from "../../src/modules/core-providers/index.ts";
import {
  describeKnownModel,
  listCatalogModels,
  lookupCatalogDialect,
  lookupCatalogModel,
} from "../../src/services/model-catalog.ts";
import {
  applyModelCatalog,
  MODEL_CATALOG_PUBLIC_KEY,
  ModelCatalogRefused,
  readModelCatalog,
} from "../../src/services/model-catalog-overlay.ts";
import { getSystemModels, initSystemModelProviderKeys } from "../../src/services/model-registry.ts";
import {
  catalogFile,
  catalogRecordLike,
  createCatalogSigner,
  type CatalogSigner,
} from "../helpers/model-catalog.ts";
import { seedTestModelProviders } from "../helpers/model-providers.ts";
import { capturePayload, recordSpec } from "../../../../packages/runner-pi/test/pi-payload.ts";

const anthropic = (coreProvidersModule.modelProviders!() as ModelProviderDefinition[]).find(
  (p) => p.providerId === "anthropic",
)!;
const BUNDLED = "claude-sonnet-5-5";
const NEXT = "claude-sonnet-9-next";
const next = (over: Record<string, unknown> = {}) => ({
  ...catalogRecordLike("anthropic", BUNDLED, "anthropic-messages", NEXT),
  ...over,
});

let signer: CatalogSigner;
beforeAll(async () => {
  signer = await createCatalogSigner();
});
afterEach(() => applyModelCatalog(null));

const read = async (payload: string, signature?: string) =>
  readModelCatalog(payload, signature ?? (await signer.sign(payload)), signer.publicKey);

describe("readModelCatalog — the file", () => {
  it("accepts a signed file built for this Pi version", async () => {
    const catalog = await read(catalogFile([next()], { serial: 7 }));
    expect(catalog).toMatchObject({ serial: 7, sourceVersion: "99.0.0", skipped: [] });
    expect(catalog.models.map((m) => `${m.provider}/${m.id}`)).toEqual([`anthropic/${NEXT}`]);
  });

  it("refuses a file whose bytes are not the signed ones", async () => {
    const payload = catalogFile([next()]);
    const signature = await signer.sign(payload);
    const tampered = payload.replace(NEXT, "claude-sonnet-9-evil");
    expect(tampered).not.toBe(payload);
    await expect(read(tampered, signature)).rejects.toThrow(/signature does not verify/);
  });

  it("refuses a file signed by another key, and a signature that is not one", async () => {
    const payload = catalogFile([next()]);
    const other = await createCatalogSigner();
    await expect(read(payload, await other.sign(payload))).rejects.toThrow(ModelCatalogRefused);
    await expect(read(payload, "not-a-signature")).rejects.toThrow(ModelCatalogRefused);
    // The production key verifies nothing a test key signed.
    await expect(
      readModelCatalog(payload, await signer.sign(payload), MODEL_CATALOG_PUBLIC_KEY),
    ).rejects.toThrow(/signature does not verify/);
  });

  // The signature names the stored file: one file, one spelling.
  it("refuses a signature that is not canonical base64", async () => {
    const payload = catalogFile([next()]);
    const signature = await signer.sign(payload);
    expect(signature.endsWith("==")).toBe(true);
    for (const spelling of [signature.slice(0, -2), `${signature}\n`, ` ${signature}`]) {
      await expect(read(payload, spelling)).rejects.toThrow(/not canonical base64/);
    }
  });

  it("pins a production key of the right size", () => {
    expect(Buffer.from(MODEL_CATALOG_PUBLIC_KEY, "base64")).toHaveLength(32);
  });

  it("refuses a file built for another Pi version", async () => {
    await expect(read(catalogFile([next()], { sdk_version: "0.0.1" }))).rejects.toThrow(
      new RegExp(`built for Pi 0.0.1, this instance runs ${PI_SDK_VERSION}`),
    );
  });

  // A record names no endpoint and no header: a hostile file must not be able
  // to redirect an authenticated request, so an extra field refuses the file.
  it("refuses a file that carries anything beyond the known fields", async () => {
    for (const extra of [{ baseUrl: "https://evil.example" }, { headers: { "x-a": "b" } }]) {
      await expect(read(catalogFile([next(extra)]))).rejects.toThrow(
        /unexpected shape at records\.0/,
      );
    }
    await expect(read(catalogFile([next()], { note: "x" }))).rejects.toThrow(/unexpected shape/);
    await expect(read(catalogFile([next()], { schema: 2 }))).rejects.toThrow(
      /unexpected shape at schema/,
    );
    await expect(read("{")).rejects.toThrow(/not JSON/);
  });
});

describe("readModelCatalog — the records", () => {
  const skippedReason = async (record: Record<string, unknown>) => {
    const catalog = await read(catalogFile([record]));
    expect(catalog.models).toEqual([]);
    return catalog.skipped[0]?.reason;
  };

  it("adds nothing the bundled registry already records", async () => {
    expect(await skippedReason(next({ id: BUNDLED }))).toBe("already in the bundled registry");
  });

  it("skips a record whose dialect the pinned Pi code may not know", async () => {
    const compat = (next().compat ?? {}) as Record<string, unknown>;
    expect(await skippedReason(next({ compat: { ...compat, supportsTelepathy: true } }))).toBe(
      'unknown compat key "supportsTelepathy"',
    );
    expect(await skippedReason(next({ thinkingLevelMap: { ludicrous: "max" } }))).toBe(
      'unknown thinking level "ludicrous"',
    );
    // A string value is a branch in Pi's code: one no bundled record uses is unknown.
    const deepseek = catalogRecordLike(
      "deepseek",
      "deepseek-flash",
      "openai-completions",
      "deepseek-next",
    );
    expect(
      await skippedReason({
        ...deepseek,
        compat: { ...(deepseek.compat as object), thinkingFormat: "telepathic" },
      }),
    ).toBe('unknown value for compat key "thinkingFormat"');
    expect((await read(catalogFile([deepseek]))).skipped).toEqual([]);
  });

  it("skips an effort word no bundled record of the API maps a level to", async () => {
    expect(await skippedReason(next({ thinkingLevelMap: { high: "ludicrous" } }))).toBe(
      'unknown effort for thinking level "high"',
    );
    const known = await read(catalogFile([next({ thinkingLevelMap: { high: "max", off: null } })]));
    expect(known.skipped).toEqual([]);
  });

  // A name every object inherits is not a word of the vocabulary.
  it("skips a compat key that is only an inherited property name", async () => {
    for (const key of ["constructor", "toString", "hasOwnProperty"]) {
      expect(await skippedReason(next({ compat: { [key]: true } }))).toBe(
        `unknown compat key "${key}"`,
      );
    }
  });

  it("skips a record of a provider or an API this build does not have", async () => {
    expect(await skippedReason(next({ provider: "not-a-pi-provider" }))).toBe(
      'no bundled record of "not-a-pi-provider" speaks "anthropic-messages"',
    );
    expect(await skippedReason(next({ api: "telepathy-messages" }))).toBe(
      'no bundled record of "anthropic" speaks "telepathy-messages"',
    );
    // Both known, never together: the pinned code has no such pair to serve.
    expect(await skippedReason(next({ api: "openai-completions", compat: undefined }))).toBe(
      'no bundled record of "anthropic" speaks "openai-completions"',
    );
  });

  it("keeps the first of two records of one id", async () => {
    const catalog = await read(catalogFile([next(), next({ name: "Twice" })]));
    expect(catalog.models).toHaveLength(1);
    expect(catalog.skipped).toEqual([{ provider: "anthropic", id: NEXT, reason: "listed twice" }]);
  });

  // The platform's refusals override these keys on every model it builds, so
  // their value in a file is never read — and never a reason to skip.
  it("does not weigh the compat keys the platform overrides", async () => {
    const compat = { ...(next().compat as object), allowedFallbackModels: [{ model: "anything" }] };
    const catalog = await read(catalogFile([next({ compat })]));
    expect(catalog.skipped).toEqual([]);
    const [model] = catalog.models;
    const built = buildPiModel({
      id: NEXT,
      ...recordSpec(model!),
      apiShape: "anthropic-messages",
      piProvider: "anthropic",
      baseUrl: "https://api.anthropic.com",
    });
    expect(built.compat).toMatchObject(PLATFORM_MODEL_COMPAT);
  });
});

describe("the offer with a live catalog applied", () => {
  const apply = async (records: unknown[] = [next()]) =>
    applyModelCatalog(await read(catalogFile(records)));

  it("offers the catalog's models next to the bundled ones, with their dialect", async () => {
    expect(lookupCatalogModel(anthropic, NEXT)).toBeNull();
    const before = listCatalogModels(anthropic).map((m) => m.id);

    await apply();

    expect(listCatalogModels(anthropic).map((m) => m.id)).toEqual([...before, NEXT]);
    const sibling = lookupCatalogModel(anthropic, BUNDLED)!;
    expect(lookupCatalogModel(anthropic, NEXT)).toEqual({
      ...sibling,
      label: `${sibling.label} (next)`,
    });
    expect(lookupCatalogDialect(anthropic, NEXT)).toEqual({
      ...lookupCatalogDialect(anthropic, BUNDLED)!,
      name: `${sibling.label} (next)`,
    });
    expect(describeKnownModel(NEXT)?.label).toBe(`${sibling.label} (next)`);
  });

  it("is not read by a lookup scoped to the bundled registry", async () => {
    await apply();
    expect(lookupCatalogModel(anthropic, NEXT, "bundled")).toBeNull();
    expect(lookupCatalogDialect(anthropic, NEXT, "bundled")).toBeNull();
    expect(listCatalogModels(anthropic, "bundled").map((m) => m.id)).not.toContain(NEXT);
    expect(lookupCatalogModel(anthropic, BUNDLED, "bundled")).not.toBeNull();
  });

  // A subscription model is priced from usage summed over requests, where a
  // tier one request can cross cannot apply (#1552).
  it("offers a subscription provider no model with a price tier one request can reach", async () => {
    const subscription = {
      ...anthropic,
      providerId: "subscription",
      catalogProviderId: "anthropic",
      authMode: "oauth2" as const,
    };
    const { cost, contextWindow } = next() as {
      cost: Record<string, number>;
      contextWindow: number;
    };
    const tiered = (id: string, inputTokensAbove: number) =>
      next({ id, cost: { ...cost, tiers: [{ ...cost, inputTokensAbove }] } });
    await apply([tiered("reachable", contextWindow - 1), tiered("unreachable", contextWindow)]);

    const ids = (def: typeof anthropic) => listCatalogModels(def).map((m) => m.id);
    expect(ids(anthropic)).toEqual(expect.arrayContaining(["reachable", "unreachable"]));
    expect(ids(subscription)).toContain("unreachable");
    expect(ids(subscription)).not.toContain("reachable");
    expect(lookupCatalogModel(subscription, "reachable")).toBeNull();
    expect(lookupCatalogDialect(subscription, "reachable")).toBeNull();
  });

  it("goes back to the bundled registry when the catalog is withdrawn", async () => {
    await apply();
    applyModelCatalog(null);
    expect(lookupCatalogModel(anthropic, NEXT)).toBeNull();
    expect(lookupCatalogDialect(anthropic, NEXT)).toBeNull();
  });

  // The point of the whole feature: the pinned code serves the new id exactly
  // as it serves the bundled sibling it shares a dialect with.
  it("builds a model the pinned Pi code serves like its bundled sibling", async () => {
    await apply();
    const build = (id: string) => {
      const entry = lookupCatalogModel(anthropic, id)!;
      return buildPiModel({
        id,
        dialect: lookupCatalogDialect(anthropic, id),
        apiShape: anthropic.apiShape,
        piProvider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: entry.capabilities.includes("reasoning"),
        contextWindow: entry.contextWindow,
        maxTokens: entry.maxTokens,
      });
    };
    expect(getPiModel("anthropic", NEXT, "anthropic-messages")).toBeUndefined();
    const { model: _sent, ...payload } = await capturePayload(build(NEXT), "high");
    const { model: _sibling, ...expected } = await capturePayload(build(BUNDLED), "high");
    expect(_sent).toBe(NEXT);
    expect(payload).toEqual(expected);
  });
});

describe("system models with a live catalog applied", () => {
  const key = (providerId: string, modelId: string) => ({
    id: `sys-${providerId}`,
    providerId,
    apiKey: "sk-system-secret",
    models: [{ id: `m-${providerId}`, modelId }],
  });
  beforeAll(seedTestModelProviders);
  afterAll(() => {
    initSystemModelProviderKeys([]);
    seedTestModelProviders();
  });

  // Remote data never decides whether an instance boots.
  it("still refuses to boot on a model only the live catalog offers", async () => {
    applyModelCatalog(await read(catalogFile([next()])));
    expect(lookupCatalogModel(anthropic, NEXT)).not.toBeNull();
    expect(() => initSystemModelProviderKeys([key("anthropic", NEXT)])).toThrow(
      new RegExp(`"${NEXT}"`),
    );
    initSystemModelProviderKeys([key("anthropic", BUNDLED)]);
    expect(getSystemModels().get("m-anthropic")?.modelId).toBe(BUNDLED);
  });
});
