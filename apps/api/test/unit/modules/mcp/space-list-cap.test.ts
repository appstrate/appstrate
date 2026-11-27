// SPDX-License-Identifier: Apache-2.0

/**
 * The `space_id` of an org-wide connection's tools lists every reached space up to
 * `SPACE_LIST_INLINE_MAX`; above it a count and `get_me` stand in, and a wrong id is still refused
 * with the full list in `accepted`.
 */

import { describe, expect, it } from "bun:test";
import { SPACE_LIST_INLINE_MAX } from "@appstrate/core/mcp-spaces";
import { registerTestPlatformApp } from "../../../helpers/platform-app.ts";
import { noExtra, orgSpace, parseResult, toolsFor } from "./helpers.ts";

await registerTestPlatformApp();

const PERMISSIONS = ["mcp:invoke", "agents:read", "agents:run", "integrations:read"];

function toolsOver(count: number) {
  const spaces = Array.from({ length: count }, (_, i) =>
    orgSpace(`spc_${i}`, `Space ${i}`, "admin", i === 0, PERMISSIONS),
  );
  const tools = toolsFor({
    origin: "https://test.local",
    orgSpaces: {
      reachable: spaces,
      current: spaces[0]!,
      dispatchIn: () => async () => Response.json({}),
    },
    authHeaders: new Headers({ authorization: "Bearer tok", "x-org-id": "org_1" }),
    permissions: new Set(PERMISSIONS),
    ceiling: undefined,
    dispatch: async () => Response.json({}),
    actor: { type: "user", id: "user_1" },
    scope: { orgId: "org_1", spaceId: "spc_0" },
    skills: {
      list: async () => [],
      entry: async () => null,
      read: async () => {
        throw new Error("not read here");
      },
    },
    fileAccess: async () => ({ grants: [] }),
    authorizeBundle: async () => {},
    placeRootAs: async () => null,
    requestId: "req_test",
    followRunLogs: () => () => {},
  });
  return new Map(tools.map((t) => [t.descriptor.name, t]));
}

const spaceIdOf = (tool: { descriptor: { inputSchema: { properties?: unknown } } }) =>
  (
    tool.descriptor.inputSchema.properties as Record<
      string,
      { enum?: string[]; description: string }
    >
  ).space_id!;

describe("space_id of org-wide tools", () => {
  it("lists every space in the enum and the description up to the cap", () => {
    const search = toolsOver(SPACE_LIST_INLINE_MAX).get("search")!;
    const property = spaceIdOf(search);
    expect(property.enum).toHaveLength(SPACE_LIST_INLINE_MAX);
    expect(property.description).toContain("Space 3 (`spc_3`, role admin)");
  });

  it("gives a count and points to get_me above the cap, without the enum", () => {
    const tools = toolsOver(SPACE_LIST_INLINE_MAX + 1);
    const search = tools.get("search")!;
    const property = spaceIdOf(search);
    expect(property.enum).toBeUndefined();
    expect(property.description).toContain(`${SPACE_LIST_INLINE_MAX + 1} spaces`);
    expect(property.description).toContain("get_me");
    expect(property.description).not.toContain("`spc_3`");
  });

  it("still refuses a wrong space_id above the cap, the ids in `accepted`", async () => {
    const count = SPACE_LIST_INLINE_MAX + 3;
    const result = parseResult(
      await toolsOver(count).get("search")!.handler({ space_id: "spc_nope" }, noExtra),
    );
    expect(result.code).toBe("unknown_space");
    expect(result.accepted).toHaveLength(count);
    expect(String(result.error)).toContain(`${count} spaces`);
    expect(String(result.error)).not.toContain("`spc_3`");
  });
});
