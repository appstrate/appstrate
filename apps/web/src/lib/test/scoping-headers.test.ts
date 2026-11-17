// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { missingScopingHeaders } from "../scoping-headers.ts";

const CURRENT = { "X-Org-Id": "org_a", "X-Space-Id": "spc_1", "X-View-As": "org_role=member" };

describe("missingScopingHeaders", () => {
  it("fills every header a request lacks", () => {
    expect(missingScopingHeaders(new Headers(), CURRENT)).toEqual(CURRENT);
  });

  it("keeps the persona on a request that names the current scope", () => {
    const present = new Headers({ "X-Org-Id": "org_a", "X-Space-Id": "spc_1" });
    expect(missingScopingHeaders(present, CURRENT)).toEqual({ "X-View-As": "org_role=member" });
  });

  it("keeps the persona on another space of the same organization", () => {
    const present = new Headers({ "X-Org-Id": "org_a", "X-Space-Id": "spc_2" });
    expect(missingScopingHeaders(present, CURRENT)).toEqual({ "X-View-As": "org_role=member" });
  });

  it("drops the persona on a request that names another organization", () => {
    const present = new Headers({ "X-Org-Id": "org_b", "X-Space-Id": "spc_9" });
    expect(missingScopingHeaders(present, CURRENT)).toEqual({});
  });
});
