// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { AGENT_UI_META_KEY, readAgentAppearance } from "../src/validation.ts";

describe("readAgentAppearance", () => {
  it("reads the manifest icon and the color under the ui meta key", () => {
    expect(
      readAgentAppearance({ icon: "🚜", _meta: { [AGENT_UI_META_KEY]: { color: "#336699" } } }),
    ).toEqual({ icon: "🚜", color: "#336699" });
  });

  it("leaves out a field that is absent, empty or not a string", () => {
    expect(readAgentAppearance({})).toEqual({});
    expect(readAgentAppearance({ icon: "", _meta: { [AGENT_UI_META_KEY]: { color: 3 } } })).toEqual(
      {},
    );
    expect(readAgentAppearance({ icon: 7, _meta: "not an object" })).toEqual({});
  });
});
