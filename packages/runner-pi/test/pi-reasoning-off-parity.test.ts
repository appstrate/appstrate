// SPDX-License-Identifier: Apache-2.0

/**
 * PARITY: what the catalog says level `off` puts on the wire
 * (`piReasoningOff`, a restatement of Pi's request builders) vs what Pi really
 * builds (`observedReasoningOff`, two captured payloads). Every record Pi
 * keeps, every API shape without a record, and the cases the UI names.
 */

import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { ALIAS_CLIENT_API_SHAPE } from "@appstrate/core/model-swap";
import type { PiModelDialect } from "@appstrate/core/sidecar-types";
import { buildPiModel, piReasoningLevels } from "../src/pi-model.ts";
import { observedReasoningOff, recordSpec } from "../src/pi-payload.ts";
import { piReasoningOff } from "../src/pi-reasoning-off.ts";
import { PROVIDER_BY_API } from "../src/provider-map.ts";
import { nativeModel } from "./pi-payload.ts";

// At run time the container talks to the sidecar: only provider-based detection fires.
const PROXY = "http://sidecar.test/llm";
// Azure records carry no baseUrl (it names the operator's resource), and Pi
// refuses to build a request without one.
const AZURE_RESOURCE = "https://resource.openai.azure.com/openai/v1";

const RECORDS = getBuiltinProviders().flatMap(
  (provider) => getBuiltinModels(provider) as Model<Api>[],
);

/** A registry record built the way the platform builds it. */
function platformModel(record: Model<Api>, baseUrl: string): Model<Api> {
  return buildPiModel({
    id: record.id,
    apiShape: record.api,
    piProvider: record.provider,
    baseUrl,
    ...recordSpec(record),
  });
}

function nativeBaseUrl(record: Model<Api>): string {
  return record.provider === "azure" && !record.baseUrl ? AZURE_RESOURCE : record.baseUrl;
}

const unrecorded = (apiShape: string, piProvider?: string, dialect: PiModelDialect | null = null) =>
  buildPiModel({
    id: "my-model",
    dialect,
    apiShape,
    piProvider,
    baseUrl: PROXY,
    reasoning: true,
  });

async function mismatches(models: Array<[string, Model<Api>]>): Promise<string[]> {
  const found = await Promise.all(
    models.map(async ([name, model]) => {
      const restated = piReasoningOff(model);
      const observed = await observedReasoningOff(model);
      if (restated === observed) return [];
      return restated === undefined
        ? [`${name}: Pi's "${model.api}" request builder is not restated, observed ${observed}`]
        : [`${name}: restated ${restated}, observed ${observed}`];
    }),
  );
  return found.flat();
}

describe("piReasoningOff ↔ the payload Pi builds for off", () => {
  const offRecords = RECORDS.filter(
    (record) => record.reasoning && piReasoningLevels(record).includes("off"),
  );

  it("agrees on every reasoning record Pi keeps that takes off, at its own URL and behind the proxy", async () => {
    expect(offRecords.length).toBeGreaterThan(0);
    const models = offRecords.flatMap((record): Array<[string, Model<Api>]> => {
      const name = `${record.provider}/${record.id}`;
      return [
        [`${name} @ native`, platformModel(record, nativeBaseUrl(record))],
        [`${name} @ proxy`, platformModel(record, PROXY)],
      ];
    });
    expect(await mismatches(models)).toEqual([]);
  });

  const shapes = new Set([...RECORDS.map((record) => record.api), ALIAS_CLIENT_API_SHAPE]);
  const pairs = [...new Set(RECORDS.map((record) => `${record.api} ${record.provider}`))].map(
    (pair) => pair.split(" ") as [string, string],
  );

  it("agrees on a model Pi keeps no record of, for every API shape and provider", async () => {
    const gateways = [...shapes]
      .filter((shape) => shape in PROVIDER_BY_API)
      .map((shape): [string, Model<Api>] => [`gateway ${shape}`, unrecorded(shape)]);
    const underProvider = pairs.map(([shape, provider]): [string, Model<Api>] => [
      `${provider} ${shape}`,
      unrecorded(shape, provider),
    ]);
    expect(gateways.length).toBe(Object.keys(PROVIDER_BY_API).length);
    expect(await mismatches([...gateways, ...underProvider])).toEqual([]);
  });

  // A string `off` is what makes Pi's per-provider `reasoning_effort` detection decide.
  it("agrees on a map that names an off effort, under every provider", async () => {
    const dialect = { name: "my-model", thinkingLevelMap: { off: "none" } };
    const models = pairs.map(([shape, provider]): [string, Model<Api>] => [
      `${provider} ${shape}`,
      unrecorded(shape, provider, dialect),
    ]);
    expect(await mismatches(models)).toEqual([]);
  });
});

describe("piReasoningOff on the cases the UI names", () => {
  const record = (provider: string, id: string) => {
    const found = nativeModel(provider, id);
    if (!found) throw new Error(`Pi keeps no ${provider}/${id} record`);
    return platformModel(found, PROXY);
  };
  const CASES: Array<[string, () => Model<Api>, ReturnType<typeof piReasoningOff>]> = [
    // openai-completions with no string `off` in its map: Pi sends no reasoning_effort.
    ["opencode-go/kimi-k2.7-code", () => record("opencode-go", "kimi-k2.7-code"), "unsent"],
    // mistral-conversations with no map: prompt_mode is only sent on.
    [
      "mistral/magistral-medium-latest",
      () => record("mistral", "magistral-medium-latest"),
      "unsent",
    ],
    ["anthropic/claude-haiku-4-5", () => record("anthropic", "claude-haiku-4-5"), "disables"],
    [
      "openrouter/amazon/nova-2-lite-v1",
      () => record("openrouter", "amazon/nova-2-lite-v1"),
      "disables",
    ],
    ["a gateway on chat completions", () => unrecorded("openai-completions"), "unsent"],
    ["a gateway on the Messages API", () => unrecorded("anthropic-messages"), "disables"],
    [
      "a model that does not reason",
      () => ({ ...unrecorded("anthropic-messages"), reasoning: false }),
      undefined,
    ],
  ];

  for (const [name, build, expected] of CASES) {
    it(`${name} → ${expected ?? "absent"}`, async () => {
      const model = build();
      expect(piReasoningOff(model)).toBe(expected);
      if (expected) {
        expect(piReasoningLevels(model)).toContain("off");
        expect(await observedReasoningOff(model)).toBe(expected);
      }
    });
  }
});
