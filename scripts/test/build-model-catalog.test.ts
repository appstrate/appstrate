// SPDX-License-Identifier: Apache-2.0

/**
 * The live model catalog's producer: what it reads of a later Pi registry,
 * which records it publishes, and that an instance accepts the file it signs.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readModelCatalog } from "../../apps/api/src/services/model-catalog-overlay.ts";
import { getPiModel, listPiModels } from "../../packages/runner-pi/src/pi-model.ts";
import { PI_SDK_VERSION } from "../../packages/runner-pi/src/provider-map.ts";
import {
  buildModelCatalog,
  readChatRecords,
  selectCatalogRecords,
  summarize,
} from "../build-model-catalog.ts";

/** The pinned Pi's own data directory. */
const BUNDLED_DATA = join(
  dirname(
    Bun.resolveSync(
      "@earendil-works/pi-ai/providers/all",
      join(import.meta.dir, "../../packages/runner-pi"),
    ),
  ),
  "data",
);
const LATER = "99.0.0";
const BUNDLED_ID = "claude-sonnet-5-5";
const bundled = getPiModel("anthropic", BUNDLED_ID, "anthropic-messages")!;

/** A throwaway signing key: its seed as the producer reads it, its public key as instances pin it. */
async function keyPair() {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return {
    seed: pkcs8.subarray(pkcs8.length - 32).toString("base64"),
    publicKey: Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64"),
  };
}

describe("build-model-catalog", () => {
  let dataDir: string;
  let key: Awaited<ReturnType<typeof keyPair>>;
  /** A data directory holding only `anthropic.json`: the bundled records plus `extra`. */
  const withRecords = (extra: Record<string, unknown>[]) => {
    const file = JSON.parse(readFileSync(join(BUNDLED_DATA, "anthropic.json"), "utf8"));
    for (const record of extra) {
      const merged = { ...bundled, type: "chat", ...record } as Record<string, unknown>;
      const api = merged["api"] as string;
      (file[api] ??= {})[`${merged["type"]}:${merged["id"]}`] = merged;
    }
    writeFileSync(join(dataDir, "anthropic.json"), JSON.stringify(file));
  };
  const build = (over: Partial<Parameters<typeof buildModelCatalog>[0]> = {}) =>
    buildModelCatalog({ dataDir, sourceVersion: LATER, ...key, ...over });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "model-catalog-"));
    key = await keyPair();
  });
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  // The layout is Pi's, read here without Pi's code: it must yield what the
  // pinned loader yields from the same files.
  it("reads the pinned data directory exactly as the pinned Pi does", () => {
    const records = readChatRecords(BUNDLED_DATA);
    const files = readdirSync(BUNDLED_DATA).filter((n) => !n.startsWith("."));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const provider = file.slice(0, -".json".length);
      const mine = records.filter((r) => r.provider === provider);
      const apis = [...new Set(mine.map((r) => r.api))];
      const pinned = apis.flatMap((api) => listPiModels(provider, api));
      expect(mine.map((r) => r.id).sort()).toEqual(pinned.map((r) => r.id).sort());
    }
  });

  it("refuses a directory that is not Pi's layout", () => {
    writeFileSync(join(dataDir, "anthropic.json"), JSON.stringify({ models: [] }));
    expect(() => readChatRecords(dataDir)).toThrow();
    withRecords([{ id: "misfiled", provider: "openai" }]);
    expect(() => readChatRecords(dataDir)).toThrow(/not filed under its provider and API/);
  });

  it("publishes the new records the pinned code serves, and says why it drops the others", async () => {
    withRecords([
      { id: "claude-next" },
      { id: "claude-new-word", compat: { ...bundled.compat, supportsTelepathy: true } },
      { id: "claude-new-field", routing: { region: "eu" } },
      { id: "claude-elsewhere", baseUrl: "https://other.example" },
      { id: "claude-no-limit", contextWindow: undefined },
      { id: "claude-image", type: "image" },
    ]);
    const { records, dropped } = await selectCatalogRecords(readChatRecords(dataDir));

    expect(records.map((r) => r.id)).toEqual(["claude-next"]);
    // Only what a model is built from: never an endpoint.
    expect(bundled.baseUrl).toBeTruthy();
    for (const field of ["baseUrl", "type", "headers"]) {
      expect(records[0]).not.toHaveProperty(field);
    }
    expect(Object.fromEntries(dropped.map((d) => [d.id, d.reason]))).toEqual({
      "claude-elsewhere": "served from an endpoint no bundled record of its provider uses",
      "claude-new-field": 'unknown field "routing"',
      "claude-new-word": 'unknown compat key "supportsTelepathy"',
      "claude-no-limit": expect.stringContaining("unexpected shape at records.0.contextWindow"),
    });
  });

  // An instance serves the `off` it derives: a record whose payloads say
  // otherwise is dropped, not mislabelled. Under mid-conversation effort Pi
  // sends adaptive thinking whatever the level, so the `off` payload equals a
  // non-reasoning model's — observed "unsent" — while the rule derives "disables".
  it("drops a record whose observed `off` differs from the derived one", async () => {
    const { off: _off, ...offAllowed } = bundled.thinkingLevelMap!;
    expect(bundled.compat).toMatchObject({ supportsMidConvoEffort: true });
    withRecords([{ id: "claude-next" }, { id: "claude-off", thinkingLevelMap: offAllowed }]);
    const { records, dropped } = await selectCatalogRecords(readChatRecords(dataDir));

    expect(records.map((r) => r.id)).toEqual(["claude-next"]);
    expect(dropped).toEqual([
      {
        provider: "anthropic",
        id: "claude-off",
        reason: 'reasoning off: derived "disables", observed "unsent"',
      },
    ]);
  });

  // The rule reads Baseten's format as a disable without looking at its
  // chat-template arguments: a record without them sends nothing and is dropped.
  it("drops a Baseten record whose `off` sends nothing the rule expects", async () => {
    const kimi = getPiModel("baseten", "moonshotai/Kimi-K2.5", "openai-completions")!;
    const { chatTemplateArgs: _args, ...compat } = kimi.compat as Record<string, unknown>;
    expect(kimi.thinkingLevelMap?.off).toBe("off");
    const source = (id: string, over: Record<string, unknown> = {}) =>
      ({ ...kimi, type: "chat", id, ...over }) as Parameters<typeof selectCatalogRecords>[0][0];
    const { records, dropped } = await selectCatalogRecords([
      source("moonshotai/Kimi-Next"),
      source("moonshotai/Kimi-No-Args", { compat }),
    ]);

    expect(records.map((r) => r.id)).toEqual(["moonshotai/Kimi-Next"]);
    expect(dropped).toEqual([
      {
        provider: "baseten",
        id: "moonshotai/Kimi-No-Args",
        reason: 'reasoning off: derived "disables", observed "unsent"',
      },
    ]);
  });

  it("signs a file an instance accepts whole", async () => {
    withRecords([{ id: "claude-next" }]);
    const built = await build({ now: () => 1_800_000_000_000 });
    const { payload, signature } = built.file!;

    const accepted = await readModelCatalog(payload, signature, key.publicKey);
    expect(accepted).toMatchObject({ serial: 1_800_000_000, sourceVersion: LATER, skipped: [] });
    expect(accepted.models.map((m) => `${m.provider}/${m.id}`)).toEqual(["anthropic/claude-next"]);
    expect(JSON.parse(payload)).toMatchObject({ schema: 1, sdk_version: PI_SDK_VERSION });
    expect(summarize(built, LATER)).toContain("- `anthropic/claude-next`");
  });

  // The seed is checked against the key instances pin before anything is written.
  it("publishes nothing under a seed that is not the pinned key's", async () => {
    withRecords([{ id: "claude-next" }]);
    const other = await keyPair();
    await expect(build({ seed: other.seed })).rejects.toThrow(/signature does not verify/);
  });

  it("publishes again only when the records change, and never lowers the serial", async () => {
    withRecords([{ id: "claude-next" }]);
    const first = (await build({ now: () => 2_000_000_000_000 })).file!;
    expect((await build({ previous: first })).file).toBeNull();

    withRecords([{ id: "claude-next" }, { id: "claude-next-2" }]);
    // A clock behind the published serial does not roll it back.
    const second = (await build({ previous: first, now: () => 1_000_000_000_000 })).file!;
    expect(JSON.parse(second.payload).serial).toBe(2_000_000_001);

    // A published file this checkout refuses is published again, above its serial.
    const rotated = await keyPair();
    const resigned = (await build({ previous: second, ...rotated, now: () => 0 })).file!;
    expect(JSON.parse(resigned.payload).serial).toBe(2_000_000_002);
    const damaged = { payload: "{", signature: second.signature };
    expect((await build({ previous: damaged })).file).not.toBeNull();
  });

  // What a registry no later than the pinned one lists and the pinned one
  // lacks was removed, not released.
  it("lists nothing from a registry that is not later than the pinned one", async () => {
    withRecords([{ id: "claude-next" }]);
    const built = await build({ sourceVersion: PI_SDK_VERSION });
    expect(built.records).toEqual([]);
    expect(JSON.parse(built.file!.payload).records).toEqual([]);
  });
});
