// SPDX-License-Identifier: Apache-2.0

/**
 * A readiness error on an integration points at the page that clears it: the
 * connections configuration for every resolver code a connection, a set or the
 * activation clears, the bundle's integrations section for the agent's own
 * integration configuration.
 */

import { describe, it, expect } from "bun:test";
import { CONNECTION_RESOLUTION_ERROR_REMEDY } from "@appstrate/core/integration";
import { routeError } from "../../../src/services/agent-diagnostics.ts";

const route = (code: string) =>
  routeError({ field: "integrations.@acme/gmail", code, message: code }).correction;

describe("agent diagnostics — integration error routing", () => {
  it("sends a governed or unbound set to the connections section", () => {
    for (const code of ["override_outranked", "required_integration_unbound"]) {
      expect(route(code)).toEqual({
        destination: "configuration",
        section: "connections",
        params: { integration: "@acme/gmail" },
      });
    }
  });

  it("routes every resolver code by its remedy", () => {
    for (const [code, remedy] of Object.entries(CONNECTION_RESOLUTION_ERROR_REMEDY)) {
      expect(route(code).section).toBe(remedy === "connection" ? "connections" : "integrations");
    }
  });

  it("sends the agent's own auth/tool mismatch to the bundle", () => {
    expect(route("auth_key_serves_no_selected_tool")).toMatchObject({
      destination: "bundle",
      section: "integrations",
    });
  });
});
