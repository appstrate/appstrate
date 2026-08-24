// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { resolveHandler } from "../handlers";

describe("package detail lab handlers", () => {
  it("resolves the Skill selected from the list by its requested id", () => {
    const response = resolveHandler(
      "GET",
      new URL("http://lab.local/api/packages/skills/@tractr/compta-references"),
      "nominal",
    );

    expect(response?.status).toBe(200);
    expect(response?.body).toMatchObject({
      id: "@tractr/compta-references",
      name: "compta-references",
    });
  });

  it("resolves the MCP server selected from the list by its requested id", () => {
    const response = resolveHandler(
      "GET",
      new URL("http://lab.local/api/packages/mcp-servers/@tractr/qbo-mcp"),
      "nominal",
    );

    expect(response?.status).toBe(200);
    expect(response?.body).toMatchObject({ id: "@tractr/qbo-mcp", name: "qbo-mcp" });
  });

  it("returns 404 for unknown Skill and MCP server identifiers", () => {
    for (const type of ["skills", "mcp-servers"]) {
      const response = resolveHandler(
        "GET",
        new URL(`http://lab.local/api/packages/${type}/@tractr/unknown`),
        "nominal",
      );
      expect(response?.status).toBe(404);
    }
  });

  it("keeps permanent package details alive in empty and error scenarios", () => {
    for (const scenario of ["empty", "error"] as const) {
      expect(
        resolveHandler(
          "GET",
          new URL("http://lab.local/api/packages/skills/@tractr/compta-references"),
          scenario,
        )?.status,
      ).toBe(200);
      expect(
        resolveHandler(
          "GET",
          new URL("http://lab.local/api/packages/mcp-servers/@tractr/qbo-mcp"),
          scenario,
        )?.status,
      ).toBe(200);
    }
  });

  it("keeps the empty-scenario shell only for permanent package detail locations", () => {
    const detailHeaders = new Headers({
      "X-Appstrate-Lab-Location": "/skills/@tractr/compta-references",
      "X-Org-Id": "org_lab",
    });
    const listHeaders = new Headers({ "X-Appstrate-Lab-Location": "/skills" });

    expect(
      resolveHandler("GET", new URL("http://lab.local/api/orgs"), "empty", detailHeaders)?.body,
    ).toHaveProperty("data.0.id", "org_lab");
    expect(
      resolveHandler("GET", new URL("http://lab.local/api/applications"), "empty", detailHeaders)
        ?.body,
    ).toHaveProperty("data.0.id", "app_lab");
    expect(
      resolveHandler("GET", new URL("http://lab.local/api/orgs"), "empty", listHeaders)?.body,
    ).toMatchObject({ data: [] });
  });
});
