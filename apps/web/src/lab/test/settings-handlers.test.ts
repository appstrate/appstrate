// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsLabState, resolveHandler } from "../handlers";

const settingsUrl = new URL("http://lab.local/api/orgs/org_lab/settings");

describe("settings lab mutations", () => {
  beforeEach(resetSettingsLabState);

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
