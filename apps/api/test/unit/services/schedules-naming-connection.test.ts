// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { integrationsNamingAny } from "../../../src/services/schedules-naming-connection.ts";

describe("integrationsNamingAny", () => {
  const owned = new Set(["conn_a", "conn_b"]);

  it("lists, sorted, the integrations naming at least one owned connection", () => {
    expect(
      integrationsNamingAny(
        {
          "@x/zeta": ["conn_other", "conn_b"],
          "@x/alpha": ["conn_a"],
          "@x/kept": ["conn_other"],
        },
        owned,
      ),
    ).toEqual(["@x/alpha", "@x/zeta"]);
  });

  it("is empty for no overrides, an empty list, or none owned", () => {
    expect(integrationsNamingAny(null, owned)).toEqual([]);
    expect(integrationsNamingAny({ "@x/a": [] }, owned)).toEqual([]);
    expect(integrationsNamingAny({ "@x/a": ["conn_a"] }, new Set())).toEqual([]);
  });
});
