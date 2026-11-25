// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type {
  IntegrationConnection,
  IntegrationDetailIn,
  IntegrationDetailWire,
} from "../../hooks/use-integrations.ts";
import { connectionRows } from "../connection-rows.ts";

function connection(id: string, locked_by: IntegrationConnection["locked_by"] = null) {
  return { id, label: id, locked_by } as IntegrationConnection;
}

function source(
  spaceId: string,
  auths: Record<string, IntegrationConnection[]>,
): IntegrationDetailIn {
  return {
    spaceId,
    detail: {
      auths: Object.entries(auths).map(([auth_key, connections]) => ({ auth_key, connections })),
    } as IntegrationDetailWire,
  };
}

describe("connectionRows", () => {
  it("lists a connection shared into several spaces once, naming every space", () => {
    const rows = connectionRows(
      [
        source("spc_a", { oauth: [connection("c1"), connection("c2")] }),
        source("spc_b", { oauth: [connection("c1")] }),
      ],
      null,
    );
    expect(rows.map((row) => [row.id, row.rowSpaceIds])).toEqual([
      ["c1", ["spc_a", "spc_b"]],
      ["c2", ["spc_a"]],
    ]);
  });

  it("reads a row as the current space does when it lists it, else as its first space", () => {
    const sources = [
      source("spc_a", { oauth: [connection("c1", null)] }),
      source("spc_b", { oauth: [connection("c1", "org_default")] }),
    ];
    const inB = connectionRows(sources, "spc_b")[0]!;
    expect([inB.rowSpaceId, inB.locked_by]).toEqual(["spc_b", "org_default"]);
    const elsewhere = connectionRows(sources, "spc_z")[0]!;
    expect([elsewhere.rowSpaceId, elsewhere.locked_by]).toEqual(["spc_a", null]);
  });

  it("stamps each row with the auth it was listed under", () => {
    const rows = connectionRows([source("spc_a", { api: [connection("k1")] })], "spc_a");
    expect(rows[0]!.auth_key).toBe("api");
  });
});
