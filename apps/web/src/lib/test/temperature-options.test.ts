// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { withStoredTemperature } from "../temperature-options";

const PRESETS = [
  { value: "__inherit__", label: "Inherit" },
  { value: "0", label: "Precise" },
  { value: "0.2", label: "Focused" },
  { value: "0.5", label: "Balanced" },
  { value: "0.8", label: "Creative" },
  { value: "1", label: "Exploratory" },
];
const format = (value: number) => new Intl.NumberFormat("fr").format(value);

describe("withStoredTemperature", () => {
  it("adds a stored value between two presets at its place in the scale", () => {
    const options = withStoredTemperature(PRESETS, 0.3, format);
    expect(options.map((option) => option.value)).toEqual([
      "__inherit__",
      "0",
      "0.2",
      "0.3",
      "0.5",
      "0.8",
      "1",
    ]);
    expect(options[3]!.label).toBe("0,3");
  });

  it("adds a stored value above the scale at its end", () => {
    const options = withStoredTemperature(PRESETS, 1.5, format);
    expect(options[options.length - 1]).toEqual({
      value: "1.5",
      label: "1,5",
    });
  });

  it("leaves the presets alone for a preset value or no stored value", () => {
    expect(withStoredTemperature(PRESETS, 0.5, format)).toEqual(PRESETS);
    expect(withStoredTemperature(PRESETS, undefined, format)).toEqual(PRESETS);
    expect(withStoredTemperature(PRESETS, null, format)).toEqual(PRESETS);
  });
});
