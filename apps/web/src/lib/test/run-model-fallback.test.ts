// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { findModelFallback } from "../run-model-fallback";

const marker = {
  event: "model_fallback",
  data: { platform: true, pinnedModelId: "mdl_pin", model: "Mistral Medium" },
};

describe("findModelFallback", () => {
  it("reads the chosen id and the model that served from the run's marker", () => {
    expect(findModelFallback([{ event: "log", data: {} }, marker])).toEqual({
      pinnedModelId: "mdl_pin",
      model: "Mistral Medium",
    });
  });

  it("is null for a run without the marker, without logs, or with a malformed one", () => {
    expect(findModelFallback([{ event: "log", data: {} }])).toBeNull();
    expect(findModelFallback(undefined)).toBeNull();
    expect(findModelFallback([{ event: "model_fallback", data: null }])).toBeNull();
    expect(findModelFallback([{ event: "model_fallback", data: { model: "X" } }])).toBeNull();
  });
});
