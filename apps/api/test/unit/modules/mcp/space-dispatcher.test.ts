// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { spaceDispatcher, type McpSpace } from "../../../../src/modules/mcp/spaces.ts";
import type { DispatchPin } from "../../../../src/lib/internal-dispatch.ts";

const space = (id: string): McpSpace => ({
  id,
  name: id,
  role: "admin",
  personal: false,
  permissions: new Set(),
  surface: {} as McpSpace["surface"],
});
const spaces = { reachable: [space("spc_a"), space("spc_b")], current: space("spc_a") };

describe("spaceDispatcher", () => {
  const sent: Array<{ space: string | null; pin: DispatchPin | undefined }> = [];
  const send = async (request: Request, pin?: DispatchPin) => {
    sent.push({ space: request.headers.get("x-space-id"), pin });
    return new Response(null);
  };
  const request = () =>
    new Request("https://test.local/api/agents", { headers: { "x-space-id": "spc_a" } });

  it("enters the space by header, and pins the dispatch only for a bound credential", async () => {
    sent.length = 0;
    await spaceDispatcher(spaces, send, false)("spc_b")(request());
    await spaceDispatcher(spaces, send, true)("spc_b")(request());
    expect(sent).toEqual([
      { space: "spc_b", pin: undefined },
      { space: "spc_b", pin: { spaceId: "spc_b" } },
    ]);
  });

  it("refuses a space the connection does not reach", () => {
    expect(() => spaceDispatcher(spaces, send, true)("spc_other")).toThrow(
      "not one this connection reaches",
    );
  });
});
