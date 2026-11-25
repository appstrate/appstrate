// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { IntegrationDetailWire } from "../../../hooks/use-integrations.ts";
import { installFakeStorage } from "../../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { DefaultConnectionSettings } = await import("../default-connection-section.tsx");
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
function section(proxy: IntegrationDetailWire["proxy_connection"], active = true) {
  return render(
    <DefaultConnectionSettings
      packageId="@acme/gmail"
      detail={{ active, auths, proxy_connection: proxy }}
    />,
  );
}

describe("DefaultConnectionSettings", () => {
  it("names the imposed account, not the reader's own", () => {
    const html = section({ status: "ready", imposed: true, connection_id: "team" });
    expect(html).toContain(
      t("integration.defaultConnection.direct.imposedAccount", { account: "CRM équipe" }),
    );
    expect(html).not.toContain("Mon compte");
  });

  it("tells when a call needs an explicit choice", () => {
    expect(section({ status: "must_choose", imposed: false })).toContain(
      t("integration.defaultConnection.direct.must_choose"),
    );
  });

  it("says a call without an agent needs a published version", () => {
    expect(section({ status: "not_published", imposed: false })).toContain(
      t("integration.defaultConnection.direct.not_published"),
    );
  });

  it("shows the inactive state even with a usable connection", () => {
    expect(
      section({ status: "ready", imposed: false, connection_id: "personal" }, false),
    ).toContain(t("integration.defaultConnection.direct.inactive"));
  });

  it("holds the space default and the agent exceptions under the verdict", () => {
    const html = section({ status: "none", imposed: false });
    expect(html).toContain(t("integration.defaultConnection.direct.none"));
    expect(html).toMatch(new RegExp(`<h3[^>]*>${t("integration.admin.exceptions.title")}</h3>`));
  });
});
