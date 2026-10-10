// SPDX-License-Identifier: Apache-2.0

/**
 * The oauth2 row of the endpoint block, rendered on its own.
 *
 * It offers exactly one control: a picker over the connections the org already
 * has, plus the "each member" choice where the model may be left to each
 * member. With neither there is nothing to bind, so no control renders. The chip
 * a selected connection turns into belongs to the host (`EndpointFields`), so it
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
  base_url: "https://api.anthropic.com",
  providerId: "claude-code",
  oauth_email: "dev@example.com",
  source: "custom",
  authMode: "oauth2",
  owner_type: "user",
  owner_id: "usr_1",
  owner_name: "Alice",
  created_by: null,
  createdAt: "2026-07-01T10:00:00.000Z",
  updatedAt: "2026-07-01T10:00:00.000Z",
};

function row(connections: ModelProviderCredentialInfo[]): string {
  return render(<ConnectionRow connections={connections} invalid={false} onSelect={() => {}} />);
}

describe("ConnectionRow — nothing to bind", () => {
  const html = row([]);

  it("renders no picker when the org has no connection and no each-member choice", () => {
    expect(html).not.toContain('role="combobox"');
  });
});

describe("ConnectionRow — connections the org already has", () => {
  const html = row([CONNECTION]);

  it("offers picking one", () => {
    // Select ITEMS are portalled and render nothing here, so the picker shows
    // up as its trigger; its contents are the host's `existingKeys` list.
    expect(html).toContain('role="combobox"');
    expect(html).toContain(settingsFr["models.form.useExistingConnection"]);
  });
});

describe("ConnectionRow — a model left to each member, with nothing to pick", () => {
  const html = render(
    <ConnectionRow
      connections={[]}
      invalid={false}
      onSelect={() => {}}
      eachMember={{ onSelect: () => {} }}
    />,
  );

  it("offers the each-member choice as the picker", () => {
    expect(html).toContain('role="combobox"');
    expect(html).toContain(settingsFr["models.form.chooseIdentity"]);
  });
});
