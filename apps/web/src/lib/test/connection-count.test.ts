// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { connectionCountBySource } from "../connection-count.ts";

const HERE = { orgId: "org_a", spaceId: "spc_here" };

function connection(orgId: string, spaceId: string | null) {
  return { org: { id: orgId }, space: spaceId === null ? null : { id: spaceId } };
}

describe("connectionCountBySource", () => {
  it("counts the org-scoped and the this-space connections of the org", () => {
    const counts = connectionCountBySource(
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
      HERE,
    );
    expect(counts.get("@appstrate/gmail")).toBe(3);
  });

  it("leaves out another space of the org and every other org", () => {
    const counts = connectionCountBySource(
      [
        {
          source_id: "@appstrate/slack",
          connections: [
            connection("org_a", "spc_elsewhere"),
            connection("org_b", null),
            connection("org_b", "spc_here"),
            connection("org_a", null),
          ],
        },
      ],
      HERE,
    );
    expect(counts.get("@appstrate/slack")).toBe(1);
  });

  it("has no entry for an integration with nothing usable here", () => {
    const counts = connectionCountBySource(
      [{ source_id: "@acme/crm", connections: [connection("org_b", null)] }],
      HERE,
    );
    expect(counts.has("@acme/crm")).toBe(false);
  });

  it("counts nothing before the org and the space are known", () => {
    const groups = [{ source_id: "@acme/crm", connections: [connection("org_a", null)] }];
    expect(connectionCountBySource(groups, { orgId: null, spaceId: "spc_here" }).size).toBe(0);
    expect(connectionCountBySource(groups, { orgId: "org_a", spaceId: null }).size).toBe(0);
  });
});
