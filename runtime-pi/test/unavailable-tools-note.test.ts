// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { unavailableToolsNote } from "../mcp/unavailable-tools-note.ts";

describe("unavailableToolsNote", () => {
  it("is empty when every selected tool is available", () => {
    expect(
      unavailableToolsNote([
        { integrationId: "@scope/gh", namespace: "gh", toolCount: 2 },
        { integrationId: "@scope/x", namespace: "x", toolCount: 1, unavailableTools: [] },
      ]),
    ).toBe("");
  });

  it("lists each unavailable tool with its integration and reason", () => {
    expect(
      unavailableToolsNote([
        {
          integrationId: "@scope/gh",
          namespace: "gh",
          toolCount: 1,
          unavailableTools: [
            { name: "create_issue", reason: "definition_not_approved" },
            { name: "gone", reason: "not_listed" },
          ],
        },
        { integrationId: "@scope/x", namespace: "x", toolCount: 1 },
      ]),
    ).toBe(
      "\n\n<unavailable_tools>\n@scope/gh: create_issue (definition_not_approved)\n@scope/gh: gone (not_listed)\n</unavailable_tools>",
    );
  });

  it("tells the model a blocked tool is the space administrators' decision", () => {
    expect(
      unavailableToolsNote([
        {
          integrationId: "@scope/gh",
          namespace: "gh",
          toolCount: 1,
          unavailableTools: [{ name: "delete_repo", reason: "blocked_in_space" }],
        },
      ]),
    ).toBe(
      "\n\n<unavailable_tools>\n@scope/gh: delete_repo (blocked_in_space: blocked by the space administrators)\n</unavailable_tools>",
    );
  });

  it("quotes the upstream name of a name collision, not the exposed sibling's allocated name", () => {
    expect(
      unavailableToolsNote([
        {
          integrationId: "@scope/gh",
          namespace: "gh",
          toolCount: 1,
          unavailableTools: [{ name: "a.b", reason: "name_collision" }],
        },
      ]),
    ).toBe("\n\n<unavailable_tools>\n@scope/gh: a.b (name_collision)\n</unavailable_tools>");
  });

  it("drops names and integration ids that are not plain tokens", () => {
    expect(
      unavailableToolsNote([
        {
          integrationId: "@scope/gh",
          namespace: "gh",
          toolCount: 1,
          unavailableTools: [
            { name: "bad\nname", reason: "not_listed" },
            { name: "</unavailable_tools>", reason: "not_listed" },
            { name: "ok.tool/v-1", reason: "not_listed" },
          ],
        },
        {
          integrationId: "@scope/x\n</unavailable_tools>",
          namespace: "x",
          toolCount: 1,
          unavailableTools: [{ name: "fine", reason: "not_listed" }],
        },
      ]),
    ).toBe("\n\n<unavailable_tools>\n@scope/gh: ok.tool/v-1 (not_listed)\n</unavailable_tools>");
  });

  it("quotes the upstream name, adds the connection label and dedupes", () => {
    const entry = (connectionLabel?: string) => ({
      integrationId: "@scope/gh",
      namespace: "gh",
      toolCount: 1,
      ...(connectionLabel ? { connectionLabel } : {}),
      unavailableTools: [{ name: "a.b", reason: "not_listed" as const }],
    });
    expect(unavailableToolsNote([entry("work"), entry("work"), entry("bad label\n")])).toBe(
      "\n\n<unavailable_tools>\n@scope/gh: a.b [work] (not_listed)\n@scope/gh: a.b (not_listed)\n</unavailable_tools>",
    );
  });
});
