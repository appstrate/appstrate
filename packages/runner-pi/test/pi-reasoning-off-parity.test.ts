// SPDX-License-Identifier: Apache-2.0

/**
 * PARITY: what the catalog says level `off` puts on the wire
 * (`piReasoningOff`, a restatement of Pi's request builders) vs what Pi really
 * builds (`observedReasoningOff`, two captured payloads), over the API shapes a
 * provider can declare: every record Pi keeps, and a model it keeps no record
 * of per shape and per provider.
 */

import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { ALIAS_BACKING_API_SHAPES } from "@appstrate/core/model-swap";
import { buildPiModel } from "../src/pi-model.ts";
import { observedReasoningOff, recordSpec, RUN_BASE_URL } from "../src/pi-payload.ts";
import { piReasoningOff, piTakesReasoningOff } from "../src/pi-reasoning-off.ts";

const SERVED: ReadonlySet<string> = new Set(ALIAS_BACKING_API_SHAPES);
const RECORDS = getBuiltinProviders()
  .flatMap((provider) => getBuiltinModels(provider) as Model<Api>[])
  .filter((record) => SERVED.has(record.api));

/** A registry record built the way a run builds it. */
function platformModel(record: Model<Api>): Model<Api> {
  return buildPiModel({
    id: record.id,
    apiShape: record.api,
    piProvider: record.provider,
    baseUrl: RUN_BASE_URL,
    ...recordSpec(record),
  });
}

const unrecorded = (apiShape: string, piProvider?: string) =>
  buildPiModel({
    id: "my-model",
    dialect: null,
    apiShape,
    piProvider,
    baseUrl: RUN_BASE_URL,
    reasoning: true,
  });

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

  it("agrees on a model Pi keeps no record of, per API shape and provider", async () => {
    const models: Array<[string, Model<Api>]> = [
      ...ALIAS_BACKING_API_SHAPES.map((shape): [string, Model<Api>] => [
        `gateway ${shape}`,
        unrecorded(shape),
      ]),
      ...pairs.map(([shape, provider]): [string, Model<Api>] => [
        `${provider} ${shape}`,
        unrecorded(shape, provider),
      ]),
    ];
    expect(await mismatches(models)).toEqual([]);
  });
});
