// SPDX-License-Identifier: Apache-2.0

/**
 * The default connection reaches those who configure the integration, active or not (a default or
 * an admin pin locks a connection while it is switched off), and only when it declares an auth.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { DefaultConnectionSection } = await import("../default-connection-section.tsx");
const { showsDefaultConnection } = await import("../../../lib/default-connection.ts");
const { render } = await import("../../../test/render.tsx");
const i18nModule = await import("../../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const grants = { canConfigure: true, fromWorkingSpace: true, authCount: 1 };

describe("showsDefaultConnection", () => {
  it("shows to a configurer, whatever the activation", () => {
    expect(showsDefaultConnection(grants)).toBe(true);
  });

  it("hides from a viewer", () => {
    expect(showsDefaultConnection({ ...grants, canConfigure: false })).toBe(false);
  });

  it("hides when the integration declares no auths", () => {
    expect(showsDefaultConnection({ ...grants, authCount: 0 })).toBe(false);
  });

  it("hides when the tab is not the working space's", () => {
    expect(showsDefaultConnection({ ...grants, fromWorkingSpace: false })).toBe(false);
  });
});

describe("DefaultConnectionSection", () => {
  it("is the tab's h2, anchored, with the exceptions as h3", () => {
    const t = i18nModule.default.getFixedT("fr", "settings");
    const html = render(<DefaultConnectionSection packageId="@acme/gmail" />, {
      queryClient: new QueryClient(),
    });
    expect(html).toContain('id="default-connection"');
    expect(html).toMatch(new RegExp(`<h2[^>]*>${t("integration.defaultConnection.title")}</h2>`));
    expect(html).toMatch(new RegExp(`<h3[^>]*>${t("integration.admin.exceptions.title")}</h3>`));
  });
});
