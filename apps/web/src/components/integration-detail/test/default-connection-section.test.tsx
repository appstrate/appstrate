// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { IntegrationDetailWire } from "../../../hooks/use-integrations.ts";
import { installFakeStorage } from "../../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { DefaultConnectionSection } = await import("../default-connection-section.tsx");
const { render } = await import("../../../test/render.tsx");
const i18nModule = await import("../../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const t = i18nModule.default.getFixedT("fr", "settings");
const auths = [
  {
    connections: [
      { id: "personal", label: "Mon compte" },
      { id: "team", label: "CRM équipe" },
    ],
  },
] as IntegrationDetailWire["auths"];
function section(
  proxy: IntegrationDetailWire["proxy_connection"],
  canConfigure = false,
  active = true,
) {
  return render(
    <DefaultConnectionSection
      packageId="@acme/gmail"
      detail={{ active, auths, proxy_connection: proxy }}
      canConfigure={canConfigure}
    />,
  );
}

describe("DefaultConnectionSection", () => {
  it("names the imposed account to the member with a personal account and keeps editing controls hidden", () => {
    const html = section({ status: "ready", imposed: true, connection_id: "team" });
    expect(html).toContain(
      t("integration.defaultConnection.direct.imposedAccount", { account: "CRM équipe" }),
    );
    expect(html).not.toContain("Mon compte");
    expect(html).not.toContain('data-testid="org-default-section"');
    expect(html).not.toContain('data-testid="pin-management-section"');
  });

  it("tells the member when a call needs an explicit choice", () => {
    expect(section({ status: "must_choose", imposed: false })).toContain(
      t("integration.defaultConnection.direct.must_choose"),
    );
  });

  it("shows the inactive state even with a usable connection", () => {
    expect(
      section({ status: "ready", imposed: false, connection_id: "personal" }, false, false),
    ).toContain(t("integration.defaultConnection.direct.inactive"));
  });

  it("is the tab's h2, anchored, with the configurer's exceptions as h3", () => {
    const html = section({ status: "none", imposed: false }, true);
    expect(html).toContain('id="default-connection"');
    expect(html).toMatch(new RegExp(`<h2[^>]*>${t("integration.defaultConnection.title")}</h2>`));
    expect(html).toMatch(new RegExp(`<h3[^>]*>${t("integration.admin.exceptions.title")}</h3>`));
  });
});
