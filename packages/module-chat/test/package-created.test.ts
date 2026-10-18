// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  packageCreatedByImport,
  packageCreatedByOperation,
  packagePageHref,
} from "../src/ui/package-created.ts";

describe("packageCreatedByOperation", () => {
  it.each([
    ["createAgent", "agent", "/agents/@acme/triage"],
    ["createSkill", "skill", "/skills/@acme/triage"],
    ["createIntegrationPackage", "integration", "/integrations/@acme/triage"],
    ["createMcpServerPackage", "mcp-server", "/mcp-servers/@acme/triage"],
  ] as const)("reads %s's 201 body and links the %s page", (operation, type, href) => {
    const created = packageCreatedByOperation(operation, {
      status: 201,
      body: { id: "@acme/triage" },
    });
    expect(created).toEqual({ packageId: "@acme/triage", type });
    expect(packagePageHref(created!)).toBe(href);
  });

  it("names nothing for another operation, or a body without an id", () => {
    expect(packageCreatedByOperation("listAgents", { body: { id: "@acme/x" } })).toBeNull();
    expect(packageCreatedByOperation("createSkill", { body: {} })).toBeNull();
    expect(packageCreatedByOperation("createSkill", null)).toBeNull();
  });
});

describe("packageCreatedByImport", () => {
  it("reads the root and the root's type of a bundle import", () => {
    expect(
      packageCreatedByImport({ root_package_id: "@acme/server", root_type: "mcp-server" }),
    ).toEqual({ packageId: "@acme/server", type: "mcp-server" });
  });

  it("names nothing without a known root type", () => {
    expect(packageCreatedByImport({ root_package_id: "@acme/x" })).toBeNull();
    expect(packageCreatedByImport({ root_package_id: "@acme/x", root_type: "tool" })).toBeNull();
    expect(packageCreatedByImport({ error: "refused" })).toBeNull();
  });
});
