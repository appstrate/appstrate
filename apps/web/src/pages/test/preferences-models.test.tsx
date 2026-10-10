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
    createdAt: CREATED,
    updatedAt: CREATED,
    ...over,
  };
}

const ORG_KEY = credential({});
const MY_KEY = credential({
  id: "cred_mine_key",
  label: "Ma clé perso",
  owner_type: "user",
  owner_id: ME,
  owner_name: "Moi",
  created_by: ME,
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
});
const ALICE_KEY = credential({
  id: "cred_alice",
  label: "Clé Alice",
  owner_type: "user",
  owner_id: "usr_alice",
  owner_name: "Alice",
  created_by: "usr_alice",
});

/** Render the page for a caller holding exactly `permissions`, with `credentials` in the cache. */
function renderFor(permissions: string[]): string {
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

/** What a cell shows when its label can be renamed in place. */
const RENAMABLE = "hover:underline";

describe("the Preferences models page, for a member who holds connect", () => {
  const html = renderFor(["model-provider-credentials:connect"]);
  const row = (credential: ModelProviderCredentialInfo) => rowOf(html, credential.label);

  it("shows the caller's own credentials and none of the others", () => {
    expect(html).toContain(MY_KEY.label);
    expect(html).toContain(MY_SUBSCRIPTION.label);
    expect(html).not.toContain(ORG_KEY.label);
    expect(html).not.toContain(ALICE_KEY.label);
  });

  it("drops the owner column, since every row is the caller's own", () => {
    expect(html).not.toContain(settingsFr["credentials.col.owner"]);
  });

  it("lets the caller rename and edit their own key", () => {
    expect(row(MY_KEY)).toContain(RENAMABLE);
    expect(row(MY_KEY)).toContain(`aria-label="${settingsFr["credentials.edit"]}"`);
  });

  it("lets the caller rename an own subscription, and reconnect it when it needs it", () => {
    expect(row(MY_SUBSCRIPTION)).toContain(RENAMABLE);
    expect(row(MY_SUBSCRIPTION)).toContain(settingsFr["credentials.oauth.reconnect"]);
  });

  it("offers the add button", () => {
    expect(html).toContain(settingsFr["credentials.add"]);
  });
});

describe("the Preferences models page, for a caller without connect", () => {
  const html = renderFor([]);

  it("still lists the caller's own credentials", () => {
    expect(html).toContain(MY_KEY.label);
  });

  it("offers no add button", () => {
    expect(html).not.toContain(settingsFr["credentials.add"]);
  });
});
