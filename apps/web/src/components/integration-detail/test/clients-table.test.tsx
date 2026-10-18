// SPDX-License-Identifier: Apache-2.0

/**
 * The OAuth client modal asks for a redirect URI only when the auth has a redirect: an oauth2 auth
 * acquired through `connect.login` gets its first token from a token request.
 */

import { describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import type { IntegrationManifestAuth } from "../../../hooks/use-integrations.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

// The dialog portals into the DOM, which the no-DOM harness lacks: render its content inline.
mock.module("../../modal.tsx", () => ({
  Modal: ({ children, actions }: { children: ReactNode; actions?: ReactNode }) => (
    <div>
      {children}
      {actions}
    </div>
  ),
}));

const { OAuthClientModal } = await import("../clients-table.tsx");
const { render } = await import("../../../test/render.tsx");
const i18nModule = await import("../../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

function modal(authDecl: Record<string, unknown>) {
  return render(
    <OAuthClientModal
      tier="org"
      packageId="@appstrate/example"
      authKey="primary"
      authDecl={authDecl as IntegrationManifestAuth}
      mode="create"
      platformRedirectUri="https://appstrate.example.test/api/integrations/callback"
      onClose={() => {}}
    />,
  );
}

describe("OAuth client modal redirect URI", () => {
  it("is shown for a plain oauth2 auth", () => {
    const html = modal({ type: "oauth2" });
    expect(html).toContain("redir-primary");
    expect(html).toContain("platform-redirect-uri-modal-primary");
  });

  it("is absent for a connect.login auth", () => {
    const html = modal({ type: "oauth2", connect: { login: { grant_type: "password" } } });
    expect(html).toContain("oauth-clientsecret-primary");
    expect(html).not.toContain("redir-primary");
    expect(html).not.toContain("platform-redirect-uri-modal-primary");
  });
});
