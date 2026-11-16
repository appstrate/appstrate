// SPDX-License-Identifier: Apache-2.0

/**
 * The stored « Vue d'ensemble » choices: only an entry set to `true` is a choice. Each write reads
 * the persisted map, so the tests drive the store through `set` rather than through its initial
 * state — the module may already be loaded by another file of the same test process.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

const storage = installFakeStorage();
const { overviewStore } = await import("../overview-store.ts");

beforeEach(() => {
  storage.setItem(
    "appstrate_overview",
    JSON.stringify({ "u_1:org_1": true, "u_1:org_2": "false", "u_1:org_3": 1, "u_1:org_4": false }),
  );
});

describe("overviewStore", () => {
  it("reads back only the entries stored as true", () => {
    overviewStore.getState().set("u_1:org_9", false);
    expect(overviewStore.getState().chosen).toEqual({ "u_1:org_1": true });
  });

  it("keeps only true entries when it writes over what another tab stored", () => {
    overviewStore.getState().set("u_1:org_5", true);
    expect(JSON.parse(storage.getItem("appstrate_overview")!)).toEqual({
      "u_1:org_1": true,
      "u_1:org_5": true,
    });
  });
});
