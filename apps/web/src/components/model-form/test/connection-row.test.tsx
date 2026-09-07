// SPDX-License-Identifier: Apache-2.0

/**
 * The oauth2 half of the endpoint block, rendered on its own.
 *
 * There is no secret to type for a subscription provider, so the row offers
 * exactly two answers — a connection the org already has, or the pairing
 * dialog. Which of the two the button names depends on whether the first one
 * exists, and that is the whole behaviour worth pinning here. The chip a
 * selected connection turns into belongs to the host (`EndpointFields`), so it
 * is deliberately not part of this component.
 */

import { describe, it, expect } from "bun:test";
import i18n, { i18nReady } from "../../../i18n.ts";
import settingsFr from "../../../locales/fr/settings.json";
import { render } from "../../../test/render.tsx";
import { ConnectionRow } from "../connection-row.tsx";
import type { ModelProviderCredentialInfo } from "../../../hooks/use-model-provider-credentials.ts";

await i18nReady;
await i18n.changeLanguage("fr");

const CONNECTION: ModelProviderCredentialInfo = {
  id: "cred_1",
  label: "Claude Code",
  apiShape: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  providerId: "claude-code",
  oauth_email: "dev@example.com",
  source: "custom",
  authMode: "oauth2",
  created_by: null,
  createdAt: "2026-07-01T10:00:00.000Z",
  updatedAt: "2026-07-01T10:00:00.000Z",
};

function row(connections: ModelProviderCredentialInfo[]): string {
  return render(
    <ConnectionRow
      connections={connections}
      providerName="Claude Code"
      invalid={false}
      onSelect={() => {}}
      onConnect={() => {}}
    />,
  );
}

describe("ConnectionRow — nothing connected yet", () => {
  const html = row([]);

  it("offers connecting, and no picker for connections that do not exist", () => {
    expect(html).toContain("Connecter Claude Code");
    expect(html).not.toContain(settingsFr["models.form.useExistingConnection"]);
  });

  it("says what the button will actually do", () => {
    expect(html).toContain(settingsFr["models.form.connectProviderHint"]);
  });
});

describe("ConnectionRow — connections the org already has", () => {
  const html = row([CONNECTION]);

  it("offers picking one, and names the button as an addition", () => {
    // Select ITEMS are portalled and render nothing here, so the picker shows
    // up as its trigger; its contents are the host's `existingKeys` list.
    expect(html).toContain(settingsFr["models.form.useExistingConnection"]);
    expect(html).toContain("Connecter un autre compte Claude Code");
    expect(html).not.toContain("Connecter Claude Code");
  });
});
