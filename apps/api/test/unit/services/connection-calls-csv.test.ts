// SPDX-License-Identifier: Apache-2.0

/** The call journal's CSV export: RFC 4180, and no formula in a column whose text a caller writes. */

import { describe, it, expect } from "bun:test";
import {
  connectionCallsCsv,
  type ConnectionCallView,
} from "../../../src/services/connection-calls.ts";

describe("connectionCallsCsv", () => {
  const row: ConnectionCallView = {
    id: 7,
    createdAt: "2026-10-12T08:00:00.000Z",
    spaceId: "spc_1",
    connection_id: "0b0f6c1e-0000-4000-8000-000000000001",
    integration_package_id: "@acme/crm",
    owner_type: "user",
    owner_id: "usr_owner",
    actor_type: "user",
    actor_id: "usr_actor",
    apiKeyId: null,
    auth_method: "session",
    runId: null,
    method: "GET",
    host: "api.example.com",
    path: "/v1/users",
    outcome: "200",
    duration_ms: 42,
    request_id: "req_1",
  };

  it("writes a header naming the wire fields, then one CRLF-terminated line per row", () => {
    expect(connectionCallsCsv([row])).toBe(
      "id,createdAt,spaceId,connection_id,integration_package_id,owner_type,owner_id,actor_type," +
        "actor_id,apiKeyId,auth_method,runId,method,host,path,outcome,duration_ms,request_id\r\n" +
        "7,2026-10-12T08:00:00.000Z,spc_1,0b0f6c1e-0000-4000-8000-000000000001,@acme/crm,user," +
        "usr_owner,user,usr_actor,,session,,GET,api.example.com,/v1/users,200,42,req_1\r\n",
    );
  });

  it("answers the header alone for no row", () => {
    expect(connectionCallsCsv([]).split("\r\n")).toHaveLength(2);
  });

  it("quotes a field holding a comma, a quote or a line break", () => {
    const line = connectionCallsCsv([{ ...row, path: '/a,b/"c"\nd' }]).split("\r\n")[1]!;
    expect(line).toContain(',"/a,b/""c""\nd",');
  });

  it("neutralises a formula in each column whose text a caller writes", () => {
    const line = connectionCallsCsv([
      {
        ...row,
        runId: "-2+3",
        method: "=1+1",
        host: "+host",
        path: "@SUM(1)",
        outcome: "\tcmd",
        request_id: "=req",
      },
    ]).split("\r\n")[1]!;
    expect(line).toEndWith(",session,'-2+3,'=1+1,'+host,'@SUM(1),'\tcmd,42,'=req");
  });

  it("exports a validated identifier as it is, leading `@` included", () => {
    const cells = connectionCallsCsv([{ ...row, actor_id: "-odd", auth_method: "=odd" }])
      .split("\r\n")[1]!
      .split(",");
    expect(cells[4]).toBe("@acme/crm");
    expect(cells[8]).toBe("-odd");
    expect(cells[10]).toBe("=odd");
  });
});
