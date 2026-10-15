// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { agentIconRef, resolveAgentIdentity } from "../agent-identity-options.ts";

describe("resolveAgentIdentity", () => {
  it("draws a picked lucide icon", () => {
    expect(resolveAgentIdentity(agentIconRef("mail")).icon).toEqual({
      kind: "lucide",
      name: "mail",
    });
  });

  it("keeps an Iconify id or an image URL from elsewhere", () => {
    expect(resolveAgentIdentity("logos:slack-icon").icon).toEqual({
      kind: "iconify",
      id: "logos:slack-icon",
    });
    expect(resolveAgentIdentity("https://cdn.example.com/a.png").icon.kind).toBe("url");
  });

  it("falls back to lucide:bot for a bare name, an unknown lucide name or none", () => {
    for (const icon of ["mail", "lucide:not-an-icon", "assets/icon.png", null, undefined]) {
      expect(resolveAgentIdentity(icon).icon).toEqual({ kind: "lucide", name: "bot" });
    }
  });
});
