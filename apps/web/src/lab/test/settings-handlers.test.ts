// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsLabState, resolveHandler } from "../handlers";

const settingsUrl = new URL("http://lab.local/api/orgs/org_lab/settings");

describe("settings lab mutations", () => {
  beforeEach(resetSettingsLabState);
  it("retains a selected default across refetches and removes it on demand", () => {
    const url = new URL("http://lab.local/api/integrations/@appstrate/google-drive/default");
    const headers = new Headers({ "X-Application-Id": "workspace-a" });
    const value = { connection_id: "connection-a", enforce: false };
    expect(resolveHandler("PUT", url, "nominal", headers, value)?.status).toBe(200);
    expect(resolveHandler("GET", url, "nominal", headers)?.body).toEqual(value);
    expect(resolveHandler("GET", url, "nominal", new Headers())?.status).toBe(204);
    resolveHandler("PUT", url, "error", headers, { ...value, enforce: true });
    expect(resolveHandler("GET", url, "nominal", headers)?.body).toEqual(value);
    resolveHandler("DELETE", url, "nominal", headers);
    expect(resolveHandler("GET", url, "nominal", headers)?.status).toBe(204);
  });

  it("keeps the collaborator SSO destination reachable after disabling it", () => {
    expect(
      resolveHandler("PUT", settingsUrl, "nominal", new Headers(), {
        dashboard_sso_enabled: false,
      })?.status,
    ).toBe(200);

    expect(resolveHandler("GET", settingsUrl, "nominal")?.body).toMatchObject({
      dashboard_sso_enabled: false,
    });
  });

  it("does not persist a failed SSO setting write", () => {
    expect(
      resolveHandler("PUT", settingsUrl, "error", new Headers(), {
        dashboard_sso_enabled: false,
      })?.status,
    ).toBe(500);

    expect(resolveHandler("GET", settingsUrl, "nominal")?.body).toMatchObject({
      dashboard_sso_enabled: true,
    });
  });
});
