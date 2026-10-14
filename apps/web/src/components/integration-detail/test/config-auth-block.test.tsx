// SPDX-License-Identifier: Apache-2.0

/**
 * An auth's configuration says, read-only, what its manifest pins: the RFC 8707 resource its
 * tokens are bound to, and the addresses its credential may reach.
 */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import type {
  IntegrationAuthStatus,
  IntegrationManifestAuth,
} from "../../../hooks/use-integrations.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { ConfigAuthBlock } = await import("../config-auth-block.tsx");
const { render } = await import("../../../test/render.tsx");
const i18nModule = await import("../../../i18n.ts");
const settingsFr = (await import("../../../locales/fr/settings.json")).default;

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

function block(status: Partial<IntegrationAuthStatus>, authDecl: Partial<IntegrationManifestAuth>) {
  return render(
    <ConfigAuthBlock
      packageId="@appstrate/gmail"
      status={{ auth_key: "primary", type: "oauth2", ...status } as IntegrationAuthStatus}
      authDecl={authDecl as IntegrationManifestAuth}
    />,
  );
}

describe("an auth's configuration", () => {
  it("shows the resource and the authorized addresses its manifest declares", () => {
    const html = block(
      { resource: "https://api.example.test" },
      { authorized_uris: ["https://api.example.test/**", "https://upload.example.test/**"] },
    );
    expect(html).toContain(settingsFr["integration.auth.resource"]);
    expect(html).toContain("https://api.example.test");
    expect(html).toContain(settingsFr["integration.structure.addresses"]);
    expect(html).toContain("https://upload.example.test/**");
  });

  it("says nothing of either when the manifest declares neither", () => {
    const html = block({ resource: undefined }, {});
    expect(html).not.toContain(settingsFr["integration.auth.resource"]);
    expect(html).not.toContain(settingsFr["integration.structure.addresses"]);
  });
});
