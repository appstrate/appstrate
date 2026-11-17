// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { AGENT_UI_META_KEY, readAgentAppearance } from "../src/validation.ts";

describe("readAgentAppearance", () => {
  it("reads the manifest icon and the palette color under the ui meta key", () => {
    expect(
      readAgentAppearance({
        icon: "lucide:tractor",
        _meta: { [AGENT_UI_META_KEY]: { color: "emerald" } },
      }),
    ).toEqual({ icon: "lucide:tractor", color: "emerald" });
    expect(
      readAgentAppearance({
        icon: "emoji:🚜",
        _meta: { [AGENT_UI_META_KEY]: { color: "neutral" } },
      }),
    ).toEqual({ icon: "emoji:🚜", color: "neutral" });
  });

  it("keeps any string icon: the client parses it", () => {
    expect(readAgentAppearance({ icon: "icon.png" }).icon).toBe("icon.png");
  });

  it("reads an absent, empty or non-string field as null", () => {
    expect(readAgentAppearance({})).toEqual({ icon: null, color: null });
    expect(readAgentAppearance({ icon: "", _meta: { [AGENT_UI_META_KEY]: { color: 3 } } })).toEqual(
      { icon: null, color: null },
    );
    expect(readAgentAppearance({ icon: 7, _meta: "not an object" })).toEqual({
      icon: null,
      color: null,
    });
  });

  it("reads a colour outside the palette as null (derived)", () => {
    for (const color of ["#336699", "red", "Blue", ""]) {
      expect(readAgentAppearance({ _meta: { [AGENT_UI_META_KEY]: { color } } }).color).toBeNull();
    }
  });
});
