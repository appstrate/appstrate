// SPDX-License-Identifier: Apache-2.0

/**
 * PARITY: the level the UI says "Auto" resolves to (`defaultReasoningLevel`,
 * `@appstrate/ui`, read off the catalog's capability map) vs the level the
 * runner really applies to an unset one (`clampPiReasoningLevel`, Pi's own
 * clamp). The UI cannot import Pi, so it restates the walk — this runs both.
 */

import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  DEFAULT_MODEL_REASONING_LEVEL,
  MODEL_REASONING_LEVELS,
  type ModelGenerationCapabilities,
} from "@appstrate/core/model-generation";
import { clampPiReasoningLevel, piReasoningLevels } from "../src/pi-model.ts";
import { defaultReasoningLevel } from "../../ui/src/components/default-reasoning-level.ts";

const model = (over: Partial<Model<Api>>): Model<Api> =>
  ({
    id: "reasoner",
    name: "Reasoner",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://example.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...over,
  }) as Model<Api>;

/** The capability map the catalog serves for a Pi record (`generationOf`, apps/api). */
function capabilitiesOf(record: Model<Api>): ModelGenerationCapabilities {
  const levels = new Set<string>(piReasoningLevels(record));
  return {
    temperature: "unknown",
    reasoning: {
      supported: record.reasoning ? "supported" : "unsupported",
      adaptive: null,
      levels: Object.fromEntries(
        MODEL_REASONING_LEVELS.map((level) => [
          level,
          levels.has(level) ? "supported" : "unsupported",
        ]),
      ),
    },
  };
}

const SHAPES: Array<[string, Partial<Model<Api>>]> = [
  ["every base level", {}],
  ["medium refused, higher taken", { thinkingLevelMap: { medium: null } }],
  [
    "medium and high refused, xhigh mapped",
    { thinkingLevelMap: { medium: null, high: null, xhigh: "xhigh" } },
  ],
  ["nothing at or above medium", { thinkingLevelMap: { medium: null, high: null } }],
  ["only off left", { thinkingLevelMap: { minimal: null, low: null, medium: null, high: null } }],
  ["no reasoning at all", { reasoning: false }],
];

describe("defaultReasoningLevel ↔ Pi's clamp", () => {
  for (const [name, over] of SHAPES) {
    it(`agrees on a model with ${name}`, () => {
      const record = model(over);
      expect(defaultReasoningLevel(capabilitiesOf(record))).toBe(
        clampPiReasoningLevel(record, DEFAULT_MODEL_REASONING_LEVEL),
      );
    });
  }
});
