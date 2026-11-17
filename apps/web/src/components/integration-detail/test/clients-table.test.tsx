// SPDX-License-Identifier: Apache-2.0

/**
 * The OAuth client modal asks for a redirect URI only when the auth has a redirect: an oauth2 auth
 * acquired through `connect.login` gets its first token from a token request.
 */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import type { IntegrationManifestAuth } from "../../../hooks/use-integrations.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { OAuthClientRedirectFields } = await import("../clients-table.tsx");
const { render } = await import("../../../test/render.tsx");
const i18nModule = await import("../../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const PLATFORM_REDIRECT_URI = "https://appstrate.example.test/api/integrations/callback";

function redirectFields(authDecl: Record<string, unknown>, redirectUri = "") {
  return render(
    <OAuthClientRedirectFields
      authKey="primary"
      authDecl={authDecl as IntegrationManifestAuth}
      redirectUri={redirectUri}
      onRedirectUriChange={() => {}}
      platformRedirectUri={PLATFORM_REDIRECT_URI}
    />,
  );
}

describe("OAuth client modal redirect URI", () => {
  it("is shown for a plain oauth2 auth, with the redirect_uri connect sends", () => {
    const html = redirectFields({ type: "oauth2" });
    expect(html).toContain("redir-primary");
    expect(html).toContain("platform-redirect-uri-modal-primary");
    expect(html).toContain(PLATFORM_REDIRECT_URI);
  });

  it("shows the client's own override as the redirect_uri connect sends", () => {
    const html = redirectFields({ type: "oauth2" }, "https://override.example.test/cb");
    expect(html).toContain("https://override.example.test/cb");
    expect(html).not.toContain(PLATFORM_REDIRECT_URI);
  });

  it("is absent for a connect.login auth", () => {
    const login = { request: { url: "https://idp.example.test/token" } };
    expect(redirectFields({ type: "oauth2", connect: { login } })).toBe("");
  });
});
