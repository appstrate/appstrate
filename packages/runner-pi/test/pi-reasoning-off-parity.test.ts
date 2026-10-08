// SPDX-License-Identifier: Apache-2.0

/**
 * PARITY: what the catalog says level `off` puts on the wire
 * (`piReasoningOff`, a restatement of Pi's request builders) vs what Pi really
 * builds (`observedReasoningOff`, two captured payloads), over the API shapes
 * the platform serves: every record Pi keeps, every shape and provider without
 * a record, and the cases the UI names.
 */

import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { MODEL_API_SHAPES, type PiModelDialect } from "@appstrate/core/sidecar-types";
import { buildPiModel, piReasoningLevels } from "../src/pi-model.ts";
import { observedReasoningOff, recordSpec } from "../src/pi-payload.ts";
import { piReasoningOff, piTakesReasoningOff } from "../src/pi-reasoning-off.ts";
import { nativeModel } from "./pi-payload.ts";

// What `piReasoningOff` answers for: a run's Pi talks to the sidecar or the llm-proxy.
const PROXY = "http://sidecar.test/llm";

const SERVED: ReadonlySet<string> = new Set(MODEL_API_SHAPES);
const RECORDS = getBuiltinProviders()
  .flatMap((provider) => getBuiltinModels(provider) as Model<Api>[])
  .filter((record) => SERVED.has(record.api));

/** A registry record built the way a run builds it. */
function platformModel(record: Model<Api>): Model<Api> {
  return buildPiModel({
    id: record.id,
    apiShape: record.api,
    piProvider: record.provider,
    baseUrl: PROXY,
    ...recordSpec(record),
  });
}

const unrecorded = (apiShape: string, piProvider?: string, dialect: PiModelDialect | null = null) =>
  buildPiModel({ id: "my-model", dialect, apiShape, piProvider, baseUrl: PROXY, reasoning: true });

async function mismatches(models: Array<[string, Model<Api>]>): Promise<string[]> {
  const found = await Promise.all(
    models.map(async ([name, model]) => {
      const restated = piReasoningOff(model);
      const observed = await observedReasoningOff(model);
      if (restated === observed) return [];
      return restated === undefined
        ? [
            `${name}: the branch of Pi's "${model.api}" builder it reaches is not restated, observed ${observed}`,
          ]
        : [`${name}: restated ${restated}, observed ${observed}`];
    }),
  );
  return found.flat();
}

describe("piReasoningOff ↔ the payload Pi builds for off", () => {
  const offRecords = RECORDS.filter(piTakesReasoningOff);

  it("agrees on every reasoning record Pi keeps that takes off", async () => {
    expect(offRecords.length).toBeGreaterThan(0);
    const models = offRecords.map((record): [string, Model<Api>] => [
      `${record.provider}/${record.id}`,
      platformModel(record),
    ]);
    expect(await mismatches(models)).toEqual([]);
  });

  const pairs = [...new Set(RECORDS.map((record) => `${record.api} ${record.provider}`))].map(
    (pair) => pair.split(" ") as [string, string],
  );

  // A string `off` is what makes Pi's per-provider `reasoning_effort` detection decide.
  const DIALECTS: Array<[string, PiModelDialect | null]> = [
    ["no map", null],
    ["an off effort", { name: "my-model", thinkingLevelMap: { off: "none" } }],
  ];

  for (const [label, dialect] of DIALECTS) {
    it(`agrees on a model Pi keeps no record of with ${label}, per API shape and provider`, async () => {
      const models: Array<[string, Model<Api>]> = [
        ...MODEL_API_SHAPES.map((shape): [string, Model<Api>] => [
          `gateway ${shape}`,
          unrecorded(shape, undefined, dialect),
        ]),
        ...pairs.map(([shape, provider]): [string, Model<Api>] => [
          `${provider} ${shape}`,
          unrecorded(shape, provider, dialect),
        ]),
      ];
      expect(await mismatches(models)).toEqual([]);
    });
  }
});

describe("piReasoningOff on the cases the UI names", () => {
  const record = (provider: string, id: string) => {
    const found = nativeModel(provider, id);
    if (!found) throw new Error(`Pi keeps no ${provider}/${id} record`);
    return platformModel(found);
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
