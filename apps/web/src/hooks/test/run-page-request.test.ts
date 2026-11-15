// SPDX-License-Identifier: Apache-2.0

/**
 * Which door a page of the Runs list asks: the current space's `GET /api/runs` unless spaces are
 * ticked, then `GET /api/orgs/{orgId}/runs` with them. And a list across spaces polls only while
 * a row still moves (the SSE stream covers the current space only).
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";
import { makeRun } from "../../test/run-fixture.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { client } = await import("../../api/client.ts");
const { fetchRunPage, pollWhileActive } = await import("../use-paginated-runs.ts");
const { ACROSS_SPACES_POLL_MS } = await import("../../lib/across-spaces.ts");

const PAGE = { object: "list", data: [], total: 0, hasMore: false };

let get: ReturnType<typeof spyOn>;
beforeEach(() => {
  get = spyOn(client, "GET").mockResolvedValue({ data: PAGE });
});
afterEach(() => get.mockRestore());

describe("fetchRunPage", () => {
  it("asks the current space by default, as it always did", async () => {
    await fetchRunPage("org_1", { status: ["failed"], search: "rap", limit: 15, offset: 0 });
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

  it("asks the org route with the ticked spaces, the other filters unchanged", async () => {
    await fetchRunPage("org_1", {
      user: "me",
      kind: "inline",
      spaceIds: ["spc_a", "spc_b"],
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
              spaceId: "spc_a,spc_b",
            },
          },
        },
      ],
    ]);
  });
});

describe("pollWhileActive", () => {
  const page = (...statuses: string[]) =>
    ({
      ...PAGE,
      data: statuses.map((status) => makeRun({ status } as never)),
    }) as never;

  it("polls while a listed run is pending or running", () => {
    expect(pollWhileActive(page("success", "running"))).toBe(ACROSS_SPACES_POLL_MS);
    expect(pollWhileActive(page("pending"))).toBe(ACROSS_SPACES_POLL_MS);
  });

  it("does not poll once every listed run has ended, nor before an answer", () => {
    expect(pollWhileActive(page("success", "failed", "cancelled"))).toBe(false);
    expect(pollWhileActive(undefined)).toBe(false);
  });
});
