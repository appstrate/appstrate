// SPDX-License-Identifier: Apache-2.0

/**
 * The schedules list asks the current space's `GET /api/schedules` unless it spans spaces, then
 * `GET /api/orgs/{orgId}/schedules`, naming no space: the server lists every one the reader
 * reaches. The files list asks `GET /api/orgs/{orgId}/files` the same way, keyset-paged like the
 * space's own; the agent index `GET /api/orgs/{orgId}/agents`, a package index
 * `GET /api/orgs/{orgId}/packages/{type}`.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { client } = await import("../../api/client.ts");
const { fetchSchedules } = await import("../use-schedules.ts");
const { fetchFilesAcrossSpaces } = await import("../use-files.ts");
const { fetchAgents, fetchPackageIndex } = await import("../use-packages.ts");

let get: ReturnType<typeof spyOn>;
beforeEach(() => {
  get = spyOn(client, "GET").mockResolvedValue({ data: { object: "list", data: [] } });
});
afterEach(() => get.mockRestore());

describe("fetchSchedules", () => {
  it("asks the current space unless it spans spaces", async () => {
    await fetchSchedules("org_1", false);
    expect(get.mock.calls).toEqual([["/api/schedules"]]);
  });

  it("asks the org route, naming no space", async () => {
    await fetchSchedules("org_1", true);
    expect(get.mock.calls).toEqual([
      ["/api/orgs/{orgId}/schedules", { params: { path: { orgId: "org_1" } } }],
    ]);
  });
});

describe("fetchFilesAcrossSpaces", () => {
  it("asks the org route with the page's query and its cursor, naming no space", async () => {
    await fetchFilesAcrossSpaces("org_1", {
      purpose: "agent_output",
      q: "rapport",
      limit: 25,
      startingAfter: "file_9",
    });
    expect(get.mock.calls).toEqual([
      [
        "/api/orgs/{orgId}/files",
        {
          params: {
            path: { orgId: "org_1" },
            query: {
              purpose: "agent_output",
              q: "rapport",
              limit: 25,
              startingAfter: "file_9",
            },
          },
          signal: undefined,
        },
      ],
    ]);
  });
});

describe("fetchAgents", () => {
  it("asks the current space unless it spans spaces", async () => {
    await fetchAgents(null);
    expect(get.mock.calls).toEqual([["/api/agents"]]);
  });

  it("asks the org route, naming no space", async () => {
    await fetchAgents("org_1");
    expect(get.mock.calls).toEqual([
      ["/api/orgs/{orgId}/agents", { params: { path: { orgId: "org_1" } } }],
    ]);
  });
});

describe("fetchPackageIndex", () => {
  it("asks the current space's index unless it spans spaces", async () => {
    await fetchPackageIndex("skill", null);
    expect(get.mock.calls).toEqual([["/api/packages/skills"]]);
  });

  it("asks the org route of each type, naming no space", async () => {
    for (const type of ["skill", "integration", "mcp-server"] as const) {
      await fetchPackageIndex(type, "org_1");
    }
    expect(get.mock.calls).toEqual(
      ["skills", "integrations", "mcp-servers"].map((segment) => [
        `/api/orgs/{orgId}/packages/${segment}`,
        { params: { path: { orgId: "org_1" } } },
      ]),
    );
  });
});
