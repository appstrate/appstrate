// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsLabState, resolveHandler } from "../handlers";

const settingsUrl = new URL("http://lab.local/api/orgs/org_lab/settings");

describe("settings lab mutations", () => {
  beforeEach(resetSettingsLabState);
  it("retains a selected default across refetches and removes it on demand", () => {
    const url = new URL("http://lab.local/api/integrations/@appstrate/google-drive/default");
    const headers = new Headers({ "X-Application-Id": "workspace-a" });
    const value = { connection_ids: ["connection-a", "connection-b"], enforce: false };
    expect(resolveHandler("PUT", url, "nominal", headers, value)?.status).toBe(200);
    expect(resolveHandler("GET", url, "nominal", headers)?.body).toMatchObject({
      integration_package_id: "@appstrate/google-drive",
      ...value,
    });
    expect(resolveHandler("GET", url, "nominal", new Headers())?.status).toBe(204);
    resolveHandler("PUT", url, "error", headers, { ...value, enforce: true });
    expect(resolveHandler("GET", url, "nominal", headers)?.body).toMatchObject(value);
    expect(resolveHandler("DELETE", url, "nominal", headers)?.status).toBe(204);
    expect(resolveHandler("GET", url, "nominal", headers)?.status).toBe(204);
  });

  it("refuses a default that names no connection, or more than ten", () => {
    const url = new URL("http://lab.local/api/integrations/@appstrate/google-drive/default");
    for (const connection_ids of [[], Array.from({ length: 11 }, (_, i) => `c${i}`)]) {
      expect(
        resolveHandler("PUT", url, "nominal", new Headers(), { connection_ids, enforce: true })
          ?.status,
      ).toBe(400);
    }
    expect(resolveHandler("GET", url, "nominal", new Headers())?.status).toBe(204);
  });

  it("keeps the collaborator SSO destination reachable after disabling it", () => {
    expect(
      resolveHandler("PATCH", settingsUrl, "nominal", new Headers(), {
        dashboard_sso_enabled: false,
      })?.status,
    ).toBe(200);

    expect(resolveHandler("GET", settingsUrl, "nominal")?.body).toMatchObject({
      dashboard_sso_enabled: false,
    });
  });

  it("does not persist a failed SSO setting write", () => {
    expect(
      resolveHandler("PATCH", settingsUrl, "error", new Headers(), {
        dashboard_sso_enabled: false,
      })?.status,
    ).toBe(500);

    expect(resolveHandler("GET", settingsUrl, "nominal")?.body).toMatchObject({
      dashboard_sso_enabled: true,
    });
  });

  describe("OAuth clients per tier", () => {
    const space = new URL(
      "http://lab.local/api/integrations/@appstrate/google-drive/auths/drive/clients",
    );
    const org = new URL(
      "http://lab.local/api/org-integrations/@appstrate/google-drive/auths/drive/clients",
    );
    const rows = (url: URL) =>
      (
        resolveHandler("GET", url, "nominal")?.body as {
          data: { client_ref: string; source: string; is_default: boolean }[];
        }
      ).data;

    it("lists the org client the space inherits, and the system one the org does", () => {
      expect(rows(space).map((c) => [c.client_ref, c.source, c.is_default])).toEqual([
        ["cli_lab_org", "org", false],
        ["cli_lab_custom", "custom", true],
        ["cli_lab_second", "custom", false],
      ]);
      expect(rows(org).map((c) => [c.client_ref, c.source, c.is_default])).toEqual([
        ["sys_a91f2c", "built-in", false],
        ["cli_lab_org", "org", true],
      ]);
    });

    it("promotes a space client to the org tier", () => {
      const promoted = resolveHandler(
        "POST",
        new URL(
          "http://lab.local/api/integrations/@appstrate/google-drive/oauth-clients/cli_lab_second/promote",
        ),
        "nominal",
      );
      expect(promoted?.body).toMatchObject({ id: "cli_lab_second", spaceId: null });
      expect(rows(org).map((c) => c.client_ref)).toContain("cli_lab_second");
      expect(rows(space).map((c) => c.client_ref)).not.toContain("cli_lab_second");
    });
  });
});
