// SPDX-License-Identifier: Apache-2.0

import { integrationClientModalRef, integrationClientModalValue } from "../integration-clients";
import { describe, expect, it } from "bun:test";
import type { IntegrationClient } from "../../hooks/use-integrations";
import { mergeClientTiers } from "../integration-clients";

function client(
  ref: string,
  source: IntegrationClient["source"],
  isDefault = false,
): IntegrationClient {
  return {
    client_ref: ref,
    source,
    client_id: `${ref}.apps.example.com`,
    is_default: isDefault,
    auto_provisioned: false,
    has_client_secret: true,
    token_endpoint_auth_method: null,
    redirect_uri: null,
  };
}

describe("mergeClientTiers", () => {
  it("lists each client once, space first, and keeps both verdicts", () => {
    const space = [client("org_a", "org"), client("sp_1", "space", true), client("sp_2", "space")];
    const org = [client("sys", "system"), client("org_a", "org", true)];

    const rows = mergeClientTiers(space, org);

    expect(rows.map((r) => r.client.client_ref)).toEqual(["sp_1", "sp_2", "org_a", "sys"]);
    expect(rows.find((r) => r.usedHere)?.client.client_ref).toBe("sp_1");
    expect(rows.find((r) => r.orgDefault)?.client.client_ref).toBe("org_a");
    const orgRow = rows.find((r) => r.client.client_ref === "org_a")!;
    expect(orgRow.inSpaceList && orgRow.inOrgList).toBe(true);
  });

  it("without the org tier, shows what the space list carries", () => {
    const rows = mergeClientTiers([client("org_a", "org", true)], undefined);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ level: "org", usedHere: true, orgDefault: false });
  });
});

it("addresses only the exact auth key when restoring a client editor URL", () => {
  const value = integrationClientModalValue("key:extended", "icl_1");
  expect(integrationClientModalRef("key:extended", value)).toBe("icl_1");
  expect(integrationClientModalRef("key", value)).toBeNull();
  expect(integrationClientModalRef("key", "key:icl_2")).toBe("icl_2");
});
