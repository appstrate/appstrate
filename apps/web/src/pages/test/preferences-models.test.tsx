// SPDX-License-Identifier: Apache-2.0

/**
 * The Preferences models page as a member sees it: their own credentials through
 * the organization's shared table, with no owner column, and the add action only
 * for a caller who holds `model-provider-credentials:connect`.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";
import settingsFr from "../../locales/fr/settings.json";
import type { ModelProviderCredentialInfo } from "../../hooks/use-model-provider-credentials.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
});

const { PreferencesModelsPage } = await import("../preferences/models.tsx");
const { orgStore } = await import("../../stores/org-store.ts");
const { authStore } = await import("../../stores/auth-store.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const ORG_ID = "org_a";
const ME = "usr_me";
const CREATED = "2026-07-01T10:00:00.000Z";

function credential(over: Partial<ModelProviderCredentialInfo>): ModelProviderCredentialInfo {
  return {
    id: "cred_org",
    label: "Clé équipe",
    apiShape: "anthropic-messages",
    base_url: "https://api.anthropic.com",
    providerId: "anthropic",
    source: "custom",
    authMode: "api_key",
    owner_type: "org",
    owner_id: null,
    owner_name: null,
    created_by: "usr_admin",
    allowed_actions: [],
    bindable: false,
    serves_model_ids: [],
    needs_reconnection: false,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...over,
  };
}

const ORG_KEY = credential({ bindable: true });
const MY_KEY = credential({
  id: "cred_mine_key",
  label: "Ma clé perso",
  owner_type: "user",
  owner_id: ME,
  owner_name: "Moi",
  created_by: ME,
  allowed_actions: ["edit", "delete", "test"],
});
const MY_SUBSCRIPTION = credential({
  id: "cred_mine_sub",
  label: "Abonnement perso",
  providerId: "claude-code",
  authMode: "oauth2",
  oauth_email: "me@example.com",
  owner_type: "user",
  owner_id: ME,
  owner_name: "Moi",
  created_by: ME,
  needs_reconnection: true,
  allowed_actions: ["edit", "delete", "reconnect"],
});
const ALICE_KEY = credential({
  id: "cred_alice",
  label: "Clé Alice",
  owner_type: "user",
  owner_id: "usr_alice",
  owner_name: "Alice",
  created_by: "usr_alice",
});

/**
 * Render the page for a caller holding exactly `permissions`, with `credentials` in the
 * cache, and the org settings loaded unless `settingsLoaded` is false.
 */
function renderFor(permissions: string[], settingsLoaded = true): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  queryClient.setQueryData(
    ["orgs"],
    [
      {
        id: ORG_ID,
        name: "Acme",
        slug: "acme",
        role: "member",
        permissions,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
  );
  queryClient.setQueryData(
    ["get", "/api/model-provider-credentials", { params: { header: { "X-Org-Id": ORG_ID } } }],
    { data: [ORG_KEY, MY_KEY, MY_SUBSCRIPTION, ALICE_KEY] },
  );
  queryClient.setQueryData(["get", "/api/models", { params: { header: { "X-Org-Id": ORG_ID } } }], {
    data: [],
  });
  if (settingsLoaded) {
    queryClient.setQueryData(
      ["get", "/api/orgs/{orgId}/settings", { params: { path: { orgId: ORG_ID } } }],
      { personal_model_credentials: true },
    );
  }
  const orgSnapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  const authSnapshot = spyOn(authStore, "getInitialState").mockReturnValue({
    ...authStore.getInitialState(),
    user: { id: ME, email: "me@example.com", emailVerified: true },
  });
  try {
    return render(<PreferencesModelsPage />, { queryClient });
  } finally {
    orgSnapshot.mockRestore();
    authSnapshot.mockRestore();
  }
}

/** The table row holding `text`, up to the next row, so a cell is read off its own row. */
function rowOf(html: string, text: string): string {
  const at = html.indexOf(text);
  if (at === -1) throw new Error(`no row holds "${text}"`);
  const next = html.indexOf("<tr", at);
  return html.slice(html.lastIndexOf("<tr", at), next === -1 ? undefined : next);
}

/** What a name shows when a click on it would rename it: it never does, the menu renames. */
const RENAMABLE = "cursor-pointer";

describe("the Preferences models page, for a member who holds connect", () => {
  const html = renderFor(["model-provider-credentials:connect"]);
  const row = (credential: ModelProviderCredentialInfo) => rowOf(html, credential.label);

  it("shows the caller's own credentials and none of the others", () => {
    expect(html).toContain(`aria-label="${settingsFr["preferences.tabModels"]}"`);
    expect(html).toContain(MY_KEY.label);
    expect(html).toContain(MY_SUBSCRIPTION.label);
    expect(html).not.toContain(ORG_KEY.label);
    expect(html).not.toContain(ALICE_KEY.label);
  });

  it("has no owner column, since every row is the caller's own, and says the kind of key", () => {
    expect(html).not.toContain("Appartient à");
    expect(html).toContain(settingsFr["providers.type.personalKey"]);
    expect(html).toContain(settingsFr["providers.col.state"]);
  });

  const menu = (credential: ModelProviderCredentialInfo) =>
    `aria-label="${settingsFr["providers.moreActions"].replace("{{name}}", credential.label)}"`;

  it("lets the caller rename an own key and an own subscription, from the menu only", () => {
    expect(row(MY_KEY)).toContain(menu(MY_KEY));
    expect(row(MY_KEY)).not.toContain(RENAMABLE);
    expect(row(MY_SUBSCRIPTION)).toContain(menu(MY_SUBSCRIPTION));
    expect(row(MY_SUBSCRIPTION)).not.toContain(RENAMABLE);
  });

  it("keeps every deed in the menu: no pencil on the row", () => {
    expect(row(MY_KEY)).not.toContain(`aria-label="${settingsFr["credentials.edit"]}"`);
    expect(row(MY_SUBSCRIPTION)).not.toContain(settingsFr["credentials.oauth.reconnect"]);
  });

  it("offers the add deed in the Actions menu, and repeats nothing while the list has rows", () => {
    expect(html).toContain("data-page-actions-trigger");
    expect(html).not.toContain(settingsFr["credentials.addPersonal"]);
  });
});

describe("the Preferences models page, before the org settings load", () => {
  const html = renderFor(["model-provider-credentials:connect"], false);

  it("withholds the Actions menu and claims no policy", () => {
    expect(html).not.toContain("data-page-actions-trigger");
    expect(html).not.toContain(settingsFr["modelCredentials.policyDisabled"]);
  });
});

describe("the Preferences models page, for a caller without connect", () => {
  const html = renderFor([]);

  it("still lists the caller's own credentials", () => {
    expect(html).toContain(MY_KEY.label);
  });

  it("offers no Actions menu", () => {
    expect(html).not.toContain("data-page-actions-trigger");
  });
});
