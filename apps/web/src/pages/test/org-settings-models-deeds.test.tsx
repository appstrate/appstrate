// SPDX-License-Identifier: Apache-2.0

/**
 * What an administrator can still do from Settings › Models besides choosing models: act on a
 * member's personal key as far as the server allows (`allowed_actions`), and test the models the
 * instance ships. The menus are portalled, so a row is read for its « … » trigger, which renders
 * only when the menu has an entry.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";
import settingsFr from "../../locales/fr/settings.json";
import type {
  ModelProviderCredentialInfo,
  ProviderRegistryEntry,
} from "../../hooks/use-model-provider-credentials.ts";
import type { OrgModelInfo } from "../../hooks/use-models.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
});

const { OrgSettingsModelsPage } = await import("../org-settings/models.tsx");
const { orgStore } = await import("../../stores/org-store.ts");
const { authStore } = await import("../../stores/auth-store.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const ORG_ID = "org_a";
const ME = "usr_admin";
const CREATED = "2026-07-01T10:00:00.000Z";
const ORG_SCOPE = { params: { header: { "X-Org-Id": ORG_ID } } };

const ANTHROPIC = {
  providerId: "anthropic",
  displayName: "Anthropic",
  iconUrl: "anthropic",
  apiShape: "anthropic-messages",
  defaultBaseUrl: "https://api.anthropic.com",
  baseUrlOverridable: false,
  authMode: "api_key",
  featured: false,
  live_model_search: false,
  personal_allowed: true,
  models: [{ id: "claude-a" }],
} as unknown as ProviderRegistryEntry;

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
    created_by: ME,
    allowed_actions: ["edit", "delete", "test"],
    bindable: true,
    needs_reconnection: false,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...over,
  };
}

/** What the server lets an administrator do with a member's key: test it, delete it. */
const BOB_KEY = credential({
  id: "cred_bob",
  label: "Clé de Bob",
  owner_type: "user",
  owner_id: "usr_bob",
  owner_name: "Bob",
  created_by: "usr_bob",
  bindable: false,
  allowed_actions: ["delete", "test"],
});

function model(over: Partial<OrgModelInfo>): OrgModelInfo {
  return {
    id: "mdl_1",
    label: "Claude A",
    apiShape: "anthropic-messages",
    providerId: "anthropic",
    provider_name: "Anthropic",
    pi_provider: "anthropic",
    pi_dialect: null,
    base_url: "https://api.anthropic.com",
    modelId: "claude-a",
    generation: null,
    enabled: true,
    is_default: false,
    needs_reconnection: false,
    aliased: false,
    iconUrl: null,
    source: "custom",
    credentialId: "cred_org",
    binding: "org",
    billed_to: "org",
    created_by: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...over,
  };
}

/** The instance ships one model, the default: there is no other default to choose. */
const SYSTEM_DEFAULT = model({
  id: "mdl_sys",
  label: "Modèle système",
  source: "built-in",
  credentialId: "cred_builtin",
  is_default: true,
});

const ADMIN = [
  "models:read",
  "models:write",
  "models:delete",
  "model-provider-credentials:read",
  "model-provider-credentials:write",
];

function renderPage(
  permissions: string[],
  data: { credentials: ModelProviderCredentialInfo[]; models: OrgModelInfo[] },
  tab = "",
): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  queryClient.setQueryData(
    ["orgs"],
    [{ id: ORG_ID, name: "Acme", slug: "acme", role: "admin", permissions, createdAt: CREATED }],
  );
  queryClient.setQueryData(["get", "/api/model-provider-credentials", ORG_SCOPE], {
    data: data.credentials,
  });
  queryClient.setQueryData(["get", "/api/model-provider-credentials/registry", ORG_SCOPE], {
    data: [ANTHROPIC],
  });
  queryClient.setQueryData(["get", "/api/models", ORG_SCOPE], { data: data.models });
  queryClient.setQueryData(
    ["get", "/api/orgs/{orgId}/settings", { params: { path: { orgId: ORG_ID } } }],
    { personal_model_credentials: true },
  );
  const orgSnapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  const authSnapshot = spyOn(authStore, "getInitialState").mockReturnValue({
    ...authStore.getInitialState(),
    user: { id: ME, email: "admin@example.com", emailVerified: true },
  });
  try {
    return render(<OrgSettingsModelsPage />, { queryClient, initialEntries: [`/${tab}`] });
  } finally {
    orgSnapshot.mockRestore();
    authSnapshot.mockRestore();
  }
}

/** The table row holding `text`, up to the next row. */
function rowOf(html: string, text: string): string {
  const at = html.indexOf(text);
  if (at === -1) throw new Error(`no row holds "${text}"`);
  const next = html.indexOf("<tr", at);
  return html.slice(html.lastIndexOf("<tr", at), next === -1 ? undefined : next);
}

const menuOf = (name: string) =>
  `aria-label="${settingsFr["providers.moreActions"].replace("{{name}}", name)}"`;

describe("a member's personal key, on the personal keys tab", () => {
  const html = renderPage(ADMIN, { credentials: [BOB_KEY], models: [] }, "?tab=personal");

  it("is listed with its holder, under the personal keys connected", () => {
    expect(html).toContain(`aria-label="${settingsFr["providers.memberKeys"]}"`);
    const row = rowOf(html, BOB_KEY.label);
    expect(row).toContain(">Bob<");
    expect(row).toContain(settingsFr["providers.type.personalKey"]);
  });

  it("carries the menu of what the server allows the caller to do with it", () => {
    expect(rowOf(html, BOB_KEY.label)).toContain(menuOf(BOB_KEY.label));
    const nothingAllowed = renderPage(
      ADMIN,
      { credentials: [{ ...BOB_KEY, allowed_actions: [] }], models: [] },
      "?tab=personal",
    );
    expect(rowOf(nothingAllowed, BOB_KEY.label)).not.toContain(menuOf(BOB_KEY.label));
  });

  it("is not listed to a caller who cannot read the organization's keys", () => {
    const reader = renderPage(
      ["models:read", "model-provider-credentials:connect"],
      { credentials: [BOB_KEY], models: [] },
      "?tab=personal",
    );
    expect(reader).not.toContain(settingsFr["providers.memberKeys"]);
  });

  it("is not a row of the organization's keys", () => {
    const orgTab = renderPage(ADMIN, { credentials: [BOB_KEY], models: [] });
    expect(orgTab).not.toContain(BOB_KEY.label);
  });
});

describe("the instance's row", () => {
  const system = settingsFr["providers.type.system"];

  it("offers its models' test to a caller who may write models, with no other default to choose", () => {
    const html = renderPage(ADMIN, { credentials: [], models: [SYSTEM_DEFAULT] });
    expect(rowOf(html, settingsFr["providers.instanceName"])).toContain(menuOf(system));
  });

  it("offers nothing to test when its only model is an alias", () => {
    const html = renderPage(ADMIN, {
      credentials: [],
      models: [{ ...SYSTEM_DEFAULT, aliased: true, binding: "managed" }],
    });
    expect(rowOf(html, settingsFr["providers.instanceName"])).not.toContain(menuOf(system));
  });

  it("offers nothing to a caller who may only read models", () => {
    const html = renderPage(["models:read"], { credentials: [], models: [SYSTEM_DEFAULT] });
    expect(rowOf(html, settingsFr["providers.instanceName"])).not.toContain(menuOf(system));
  });
});
