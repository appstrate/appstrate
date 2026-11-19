// SPDX-License-Identifier: Apache-2.0

/**
 * Which door a page of the Runs list asks: the current space's `GET /api/runs` unless it spans
 * spaces, then `GET /api/orgs/{orgId}/runs`, naming no space. An agent's runs are the same list
 * narrowed by `packageId`, on either door.
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
    await fetchRunPage({
      status: ["failed"],
      search: "rap",
      acrossOrgId: null,
      limit: 15,
    });
    expect(get.mock.calls).toEqual([
      [
        "/api/runs",
        {
          params: {
            query: {
              limit: 15,
              startingAfter: undefined,
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
      startingAfter: "run_15",
    });
    expect(get.mock.calls).toEqual([
      [
        "/api/orgs/{orgId}/runs",
        {
          params: {
            path: { orgId: "org_1" },
            query: {
              limit: 15,
              startingAfter: "run_15",
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

  it("narrows either door to one agent with packageId", async () => {
    for (const acrossOrgId of [null, "org_1"]) {
      await fetchRunPage({ packageId: "@acme/reporter", acrossOrgId, limit: 25 });
    }
    expect(
      (get.mock.calls as [string, { params: { query: { packageId?: string } } }][]).map(
        ([path, init]) => [path, init.params.query.packageId],
      ),
    ).toEqual([
      ["/api/runs", "@acme/reporter"],
      ["/api/orgs/{orgId}/runs", "@acme/reporter"],
    ]);
  });
});
