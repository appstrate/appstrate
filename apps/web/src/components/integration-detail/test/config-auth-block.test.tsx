// SPDX-License-Identifier: Apache-2.0

/**
 * An auth's configuration says, read-only, what its manifest pins: the RFC 8707 resource its
 * tokens are bound to, and the addresses its credential may reach.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import type {
  IntegrationAuthStatus,
  IntegrationManifestAuth,
} from "../../../hooks/use-integrations.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { ConfigAuthBlock } = await import("../config-auth-block.tsx");
const { $api } = await import("../../../api/client.ts");
const { render } = await import("../../../test/render.tsx");
const i18nModule = await import("../../../i18n.ts");
const settingsFr = (await import("../../../locales/fr/settings.json")).default;

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const PACKAGE_ID = "@appstrate/gmail";
const REDIRECT_URI = "https://appstrate.example.test/api/integrations/callback";

function block(status: Partial<IntegrationAuthStatus>, authDecl: Partial<IntegrationManifestAuth>) {
  // The integration detail the redirect URI is read from, under the key its hook reads with no
  // org or space selected.
  const queryClient = new QueryClient();
  const { queryKey } = $api.queryOptions("get", "/api/integrations/{packageId}", {
    params: {
      path: { packageId: PACKAGE_ID },
      header: { "X-Org-Id": undefined, "X-Space-Id": undefined },
    },
  });
  queryClient.setQueryData(queryKey, { platform_redirect_uri: REDIRECT_URI });
  return render(
    <ConfigAuthBlock
      packageId={PACKAGE_ID}
      status={{ auth_key: "primary", type: "oauth2", ...status } as IntegrationAuthStatus}
      authDecl={authDecl as IntegrationManifestAuth}
    />,
    { queryClient },
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

  it("shows the redirect URI to register for an authorization-code oauth2 auth", () => {
    const html = block({}, { type: "oauth2" });
    expect(html).toContain(settingsFr["integration.oauthClient.platformRedirectUri"]);
    expect(html).toContain(REDIRECT_URI);
  });

  it("shows no redirect URI for an oauth2 auth acquired by connect.login", () => {
    const html = block({}, {
      type: "oauth2",
      connect: { login: { request: { url: "https://idp.example.test/token" } } },
    } as Partial<IntegrationManifestAuth>);
    expect(html).not.toContain(settingsFr["integration.oauthClient.platformRedirectUri"]);
    expect(html).not.toContain(REDIRECT_URI);
  });
});
