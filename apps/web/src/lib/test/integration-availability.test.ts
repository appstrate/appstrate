// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { availabilityLabel } from "../integration-availability";

const base = { shared_by: null } as const;

describe("availabilityLabel", () => {
  it("names the provenance of an active placement", () => {
    expect(availabilityLabel({ ...base, via: "home", state: "active" }).key).toBe(
      "integration.availability.home",
    );
    expect(availabilityLabel({ ...base, via: "system", state: "active" }).key).toBe(
      "integration.availability.system",
    );
    expect(availabilityLabel({ ...base, via: "organization", state: "active" }).key).toBe(
      "integration.availability.organization",
    );
  });

  it("names the sharer of a shared placement, or says « partagée » without one", () => {
    expect(
      availabilityLabel({
        via: "shared",
        state: "active",
        shared_by: { user_id: "u", name: "Ada" },
      }),
    ).toEqual({ key: "integration.availability.sharedBy", params: { name: "Ada" } });
    expect(availabilityLabel({ ...base, via: "shared", state: "active" })).toEqual({
      key: "integration.availability.shared",
      params: {},
    });
  });

  it("reads inactive whatever the provenance", () => {
    for (const via of ["home", "shared", "system", "organization"] as const) {
      for (const state of ["inactive", "none"] as const) {
        expect(availabilityLabel({ ...base, via, state })).toEqual({
          key: "integrations.badge.inactive",
          params: {},
        });
      }
    }
  });
});
