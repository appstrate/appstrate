// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { resetAgentEditorLabState, resolveHandler } from "../handlers";

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
      resolveHandler("GET", new URL("http://lab.local/api/spaces"), "empty", detailHeaders)?.body,
    ).toHaveProperty("data.0.id", "app_lab");
    expect(
      resolveHandler("GET", new URL("http://lab.local/api/orgs"), "empty", listHeaders)?.body,
    ).toMatchObject({ data: [] });
  });

  describe("draft saves", () => {
    beforeEach(resetAgentEditorLabState);
    const url = new URL("http://lab.local/api/packages/skills/@tractr/triage-sentiment");

    it("stamps the detail with an ETag that a save sends back and moves forward", () => {
      const etag = resolveHandler("GET", url, "nominal")?.headers?.ETag;
      expect(etag).toBe('W/"1"');
      const saved = resolveHandler("PATCH", url, "nominal", new Headers({ "If-Match": etag! }), {
        manifest: { name: "@tractr/triage-sentiment" },
      });
      expect(saved?.status).toBe(200);
      expect(saved?.headers?.ETag).toBe('W/"2"');
      expect(resolveHandler("GET", url, "nominal")?.headers?.ETag).toBe('W/"2"');
    });

    it("refuses a save on a stale or a missing If-Match", () => {
      const stale = new Headers({ "If-Match": 'W/"0"' });
      expect(resolveHandler("PATCH", url, "nominal", stale, {})?.status).toBe(412);
      expect(resolveHandler("PATCH", url, "nominal", new Headers(), {})?.status).toBe(428);
    });
  });

  describe("chat enforcement", () => {
    const spaceUrl = (pkg: string) =>
      new URL(`http://lab.local/api/spaces/app_lab_default/packages/${pkg}`);
    const enforced = () =>
      (
        resolveHandler(
          "GET",
          new URL("http://lab.local/api/chat/enforced-skills"),
          "nominal",
          new Headers({ "X-Space-Id": "app_lab_default" }),
        )?.body as { data: { id: string }[] }
      ).data.map((skill) => skill.id);

    it("lists what the library enforces and follows the space's toggle", () => {
      expect(enforced()).toEqual(["@tractr/compta-references"]);
      const released = resolveHandler(
        "PATCH",
        spaceUrl("@tractr/compta-references"),
        "nominal",
        new Headers(),
        { chat_enforced: false },
      );
      expect(released?.body).toMatchObject({ chat_enforced: false, package_type: "skill" });
      expect(enforced()).toEqual([]);
      resolveHandler("PATCH", spaceUrl("@tractr/compta-references"), "nominal", new Headers(), {
        chat_enforced: true,
      });
      expect(enforced()).toEqual(["@tractr/compta-references"]);
    });

    it("refuses to enforce an unpublished skill or a non-skill", () => {
      const unpublished = resolveHandler(
        "PATCH",
        new URL("http://lab.local/api/spaces/app_lab_personal/packages/@tractr/notes-client"),
        "nominal",
        new Headers(),
        { chat_enforced: true },
      );
      expect(unpublished?.status).toBe(409);
      expect(unpublished?.body).toMatchObject({ code: "no_published_version" });
      expect(
        resolveHandler("PATCH", spaceUrl("@tractr/wiki-brain"), "nominal", new Headers(), {
          chat_enforced: true,
        })?.status,
      ).toBe(400);
    });
  });
});
