// SPDX-License-Identifier: Apache-2.0

/**
 * An integration whose only method is oauth2 without a usable client cannot be
 * connected (the server answers 403). Whoever may register the client is
 * offered to set the method up; anyone else is told an administrator must,
 * on a dead « Ajouter » rather than nothing at all.
 */

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../../i18n.ts";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import { render } from "../../../test/render.tsx";
import type { IntegrationDetailWire } from "../../../hooks/use-integrations.ts";
import { AddIntegrationConnection } from "../add-integration-connection.tsx";

await i18nReady;
await i18n.changeLanguage("fr");
installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const DETAIL = {
  manifest: { auths: { primary: { type: "oauth2" } } },
  auths: [
    {
      auth_key: "primary",
      type: "oauth2",
      connections: [],
      has_oauth_client: false,
      has_system_client: false,
      client_auto_provisioned: false,
    },
  ],
} as unknown as IntegrationDetailWire;

function renderAdd(rights: { canConfigure: boolean; canConnect: boolean }) {
  return render(
    <AddIntegrationConnection
      packageId="@acme/gmail"
      detail={DETAIL}
      onConfigure={() => {}}
      {...rights}
    />,
  );
}

describe("adding a connection to an oauth2 integration without a client", () => {
  it("tells a member an administrator must register one", () => {
    const html = renderAdd({ canConfigure: false, canConnect: true });
    expect(html).toContain('data-testid="no-oauth-client"');
    expect(html).toContain(i18n.t("integration.auth.noClientHint", { ns: "settings" }));
  });

  it("CONTROL: offers whoever may configure to set the method up", () => {
    const html = renderAdd({ canConfigure: true, canConnect: true });
    expect(html).not.toContain('data-testid="no-oauth-client"');
    expect(html).toContain(i18n.t("integration.presentation.configureAuth", { ns: "settings" }));
  });
});
