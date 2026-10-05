// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { isQueryInFlight } from "../query-state";

describe("isQueryInFlight", () => {
  it("is true while fetching without data", () => {
    expect(isQueryInFlight({ isPending: true, fetchStatus: "fetching" })).toBe(true);
  });

  it("is true while a retry is paused (background tab): pending and not idle is still loading", () => {
    expect(isQueryInFlight({ isPending: true, fetchStatus: "paused" })).toBe(true);
  });

  it("is false for a disabled query, which is pending but idle", () => {
    expect(isQueryInFlight({ isPending: true, fetchStatus: "idle" })).toBe(false);
  });

  it("is false once the query has settled, refetching or not", () => {
    expect(isQueryInFlight({ isPending: false, fetchStatus: "idle" })).toBe(false);
    expect(isQueryInFlight({ isPending: false, fetchStatus: "fetching" })).toBe(false);
  });
});
