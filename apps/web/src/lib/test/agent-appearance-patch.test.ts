// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { agentAppearancePatch } from "../agent-appearance-patch.ts";

describe("agentAppearancePatch", () => {
  it("writes a picked icon and nothing else", () => {
    expect(agentAppearancePatch({}, { icon: "lucide:mail" })).toStrictEqual({
      icon: "lucide:mail",
    });
  });

  it("clears the icon key when the icon is removed", () => {
    expect(agentAppearancePatch({ icon: "lucide:mail" }, { icon: null })).toStrictEqual({
      icon: undefined,
    });
  });

  it("writes a colour under the Appstrate ui meta, keeping the rest of _meta", () => {
    const manifest = {
      _meta: { "dev.appstrate/resources": { cpu: 2 }, "dev.appstrate/ui": { other: 1 } },
    };
    expect(agentAppearancePatch(manifest, { color: "blue" })).toStrictEqual({
      _meta: {
        "dev.appstrate/resources": { cpu: 2 },
        "dev.appstrate/ui": { other: 1, color: "blue" },
      },
    });
  });

  it("writes neutral, an explicit choice", () => {
    expect(agentAppearancePatch({}, { color: "neutral" })).toStrictEqual({
      _meta: { "dev.appstrate/ui": { color: "neutral" } },
    });
  });

  it("removes the colour and prunes the _meta objects it leaves empty", () => {
    const manifest = { _meta: { "dev.appstrate/ui": { color: "rose" } } };
    expect(agentAppearancePatch(manifest, { color: null })).toStrictEqual({ _meta: undefined });
  });

  it("keeps the other ui keys and _meta entries when the colour is removed", () => {
    const manifest = {
      _meta: { "dev.appstrate/resources": { cpu: 2 }, "dev.appstrate/ui": { color: "rose" } },
    };
    expect(agentAppearancePatch(manifest, { color: null })).toStrictEqual({
      _meta: { "dev.appstrate/resources": { cpu: 2 } },
    });
  });

  it("changes the icon and the colour of one call independently", () => {
    expect(agentAppearancePatch({}, { icon: "lucide:bot", color: "cyan" })).toStrictEqual({
      icon: "lucide:bot",
      _meta: { "dev.appstrate/ui": { color: "cyan" } },
    });
  });
});
