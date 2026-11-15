// SPDX-License-Identifier: Apache-2.0

/**
 * Which door a page of the Runs list asks: the current space's `GET /api/runs` unless it spans
 * spaces, then `GET /api/orgs/{orgId}/runs`, naming no space.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { client } = await import("../../api/client.ts");
const { fetchRunPage } = await import("../use-paginated-runs.ts");

const PAGE = { object: "list", data: [], total: 0, hasMore: false };

let get: ReturnType<typeof spyOn>;
beforeEach(() => {
  get = spyOn(client, "GET").mockResolvedValue({ data: PAGE });
});
afterEach(() => get.mockRestore());

describe("fetchRunPage", () => {
  it("asks the current space unless it spans spaces", async () => {
    await fetchRunPage({ status: ["failed"], search: "rap", limit: 15, offset: 0 });
    expect(get.mock.calls).toEqual([
      [
        "/api/runs",
        {
          params: {
            query: {
              limit: 15,
              offset: 0,
              user: undefined,
              kind: undefined,
              status: ["failed"],
              q: "rap",
              unread: undefined,
            },
          },
        },
      ],
    ]);
  });

  it("asks the org route naming no space, the other filters unchanged", async () => {
    await fetchRunPage({
      user: "me",
      kind: "inline",
      acrossOrgId: "org_1",
      limit: 15,
      offset: 15,
    });
    expect(get.mock.calls).toEqual([
      [
        "/api/orgs/{orgId}/runs",
        {
          params: {
            path: { orgId: "org_1" },
            query: {
              limit: 15,
              offset: 15,
              user: "me",
              kind: "inline",
              status: undefined,
              q: undefined,
              unread: undefined,
            },
          },
        },
      ],
    ]);
  });
});
