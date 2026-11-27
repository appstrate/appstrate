// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import type { UnavailableToolReason } from "@appstrate/core/sidecar-types";
import { unavailableToolsNote } from "../mcp/unavailable-tools-note.ts";

const entry = (
  unavailableTools?: Array<{ name: string; reason: UnavailableToolReason }>,
  integrationId = "@scope/gh",
) => ({
  integrationId,
  namespace: "gh",
  toolCount: 1,
  ...(unavailableTools && { unavailableTools }),
});

const note = (...lines: string[]) =>
  `\n\n<unavailable_tools>\n${lines.join("\n")}\n</unavailable_tools>`;

describe("unavailableToolsNote", () => {
  it("is empty when every selected tool is available", () => {
    expect(unavailableToolsNote([entry(), entry([], "@scope/x")])).toBe("");
  });

  it("lists each unavailable tool with its integration and reason", () => {
    expect(
      unavailableToolsNote([
        entry([
          { name: "create_issue", reason: "definition_not_approved" },
          { name: "gone", reason: "not_listed" },
        ]),
        entry(undefined, "@scope/x"),
      ]),
    ).toBe(
      note("@scope/gh: create_issue (definition_not_approved)", "@scope/gh: gone (not_listed)"),
    );
  });

  it.each<[UnavailableToolReason, string]>([
    ["blocked_in_space", "blocked_in_space: blocked by the space administrators"],
    ["name_collision", "name_collision"],
  ])("states the %s reason", (reason, text) => {
    expect(unavailableToolsNote([entry([{ name: "a.b", reason }])])).toBe(
      note(`@scope/gh: a.b (${text})`),
    );
  });

  it("drops names that are not plain tokens", () => {
    expect(
      unavailableToolsNote([
        entry([
          { name: "bad\nname", reason: "not_listed" },
          { name: "</unavailable_tools>", reason: "not_listed" },
          { name: "ok.tool-v1", reason: "not_listed" },
        ]),
      ]),
    ).toBe(note("@scope/gh: ok.tool-v1 (not_listed)"));
  });

  it("dedupes the identical lines of several connections", () => {
    const one = entry([{ name: "a.b", reason: "not_listed" }]);
    expect(unavailableToolsNote([one, one])).toBe(note("@scope/gh: a.b (not_listed)"));
  });
});
