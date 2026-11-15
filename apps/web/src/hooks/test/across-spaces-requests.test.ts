// SPDX-License-Identifier: Apache-2.0

/**
 * The schedules list asks the current space's `GET /api/schedules` unless spaces are ticked,
 * then `GET /api/orgs/{orgId}/schedules` with them; across spaces it polls only while a listed
 * schedule has a run going. The files list asks `GET /api/orgs/{orgId}/files` the same way,
 * keyset-paged like the space's own.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { EnrichedSchedule } from "@appstrate/shared-types";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { client } = await import("../../api/client.ts");
const { fetchSchedules, pollWhileScheduleRuns } = await import("../use-schedules.ts");
const { fetchFilesAcrossSpaces } = await import("../use-files.ts");
const { ACROSS_SPACES_POLL_MS } = await import("../../lib/across-spaces.ts");

let get: ReturnType<typeof spyOn>;
beforeEach(() => {
  get = spyOn(client, "GET").mockResolvedValue({ data: { object: "list", data: [] } });
});
afterEach(() => get.mockRestore());

describe("fetchSchedules", () => {
  it("asks the current space by default, as it always did", async () => {
    await fetchSchedules("org_1", undefined);
    await fetchSchedules("org_1", []);
    expect(get.mock.calls).toEqual([["/api/schedules"], ["/api/schedules"]]);
  });

  it("asks the org route with the ticked spaces", async () => {
    await fetchSchedules("org_1", ["spc_a", "spc_b"]);
    expect(get.mock.calls).toEqual([
      [
        "/api/orgs/{orgId}/schedules",
        { params: { path: { orgId: "org_1" }, query: { spaceId: "spc_a,spc_b" } } },
      ],
    ]);
  });
});

describe("pollWhileScheduleRuns", () => {
  const schedule = (running_runs: number) => ({ running_runs }) as EnrichedSchedule;

  it("polls while a listed schedule has a run going, and only then", () => {
    expect(pollWhileScheduleRuns([schedule(0), schedule(1)])).toBe(ACROSS_SPACES_POLL_MS);
    expect(pollWhileScheduleRuns([schedule(0)])).toBe(false);
    expect(pollWhileScheduleRuns(undefined)).toBe(false);
  });
});

describe("fetchFilesAcrossSpaces", () => {
  it("asks the org route with the ticked spaces, the page's query and its cursor", async () => {
    await fetchFilesAcrossSpaces("org_1", ["spc_a", "spc_b"], {
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
              spaceId: "spc_a,spc_b",
            },
          },
          signal: undefined,
        },
      ],
    ]);
  });
});
