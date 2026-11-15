// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { connectionCounter } from "../connection-count.ts";

function connection(orgId: string, spaceId: string | null) {
  return { org: { id: orgId }, space: spaceId === null ? null : { id: spaceId } };
}

describe("connectionCounter", () => {
  it("counts the org-scoped and the that-space connections of the org", () => {
    const count = connectionCounter(
      [
        {
          source_id: "@appstrate/gmail",
          connections: [
            connection("org_a", null),
            connection("org_a", "spc_here"),
            connection("org_a", null),
          ],
        },
      ],
      "org_a",
    );
    expect(count("@appstrate/gmail", "spc_here")).toBe(3);
  });

  it("counts in the row's space: another space of the org keeps only the org-scoped ones", () => {
    const groups = [
      {
        source_id: "@appstrate/slack",
        connections: [
          connection("org_a", "spc_elsewhere"),
          connection("org_b", null),
          connection("org_b", "spc_here"),
          connection("org_a", null),
        ],
      },
    ];
    const count = connectionCounter(groups, "org_a");
    expect(count("@appstrate/slack", "spc_here")).toBe(1);
    expect(count("@appstrate/slack", "spc_elsewhere")).toBe(2);
  });

  it("is 0 for an integration with nothing usable there", () => {
    const count = connectionCounter(
      [{ source_id: "@acme/crm", connections: [connection("org_b", null)] }],
      "org_a",
    );
    expect(count("@acme/crm", "spc_here")).toBe(0);
    expect(count("@acme/unknown", "spc_here")).toBe(0);
  });

  it("counts nothing before the org is known", () => {
    const groups = [{ source_id: "@acme/crm", connections: [connection("org_a", null)] }];
    expect(connectionCounter(groups, null)("@acme/crm", "spc_here")).toBe(0);
  });
});
