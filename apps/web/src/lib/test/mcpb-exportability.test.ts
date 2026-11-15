// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { mcpbExportRefusal } from "../mcpb-exportability.ts";

const local = {
  name: "@acme/ssh",
  version: "1.0.0",
  type: "integration",
  source: {
    kind: "local",
    server: {
      type: "node",
      entry_point: "server/index.js",
      mcp_config: { command: "node", args: ["server/index.js"] },
    },
  },
};

describe("mcpbExportRefusal", () => {
  it("accepts a local integration with no auth and no variables", () => {
    expect(mcpbExportRefusal(local)).toBeNull();
  });

  it("refuses a non-local integration", () => {
    expect(mcpbExportRefusal({ ...local, source: { kind: "none" } })?.code).toBe("mcpb_not_local");
  });

  it("refuses connection variables", () => {
    expect(mcpbExportRefusal({ ...local, variables: { base: {} } })?.code).toBe(
      "mcpb_unsupported_variables",
    );
  });

  it("refuses more than one auth method, and a credential delivered over HTTP", () => {
    expect(mcpbExportRefusal({ ...local, auths: { a: {}, b: {} } })?.code).toBe(
      "mcpb_unsupported_auth",
    );
    expect(mcpbExportRefusal({ ...local, auths: { a: { delivery: { http: {} } } } })?.code).toBe(
      "mcpb_unsupported_auth",
    );
  });
});
