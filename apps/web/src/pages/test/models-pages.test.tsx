// SPDX-License-Identifier: Apache-2.0

/**
 * Settings › Models and Preferences › Models, rendered for the role that opens them. React Query
 * fires a query when ANY observer is enabled, so the credentials observers are recorded through
 * `QueryCache.build`: a member who may only read models must not fetch them. Menus and the open
 * row's panel are portalled or folded, so a row is read collapsed: its label, summary, state and
 * the repair it offers.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient, type QueryCache } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";
import settingsFr from "../../locales/fr/settings.json";
import type { ModelConfigInfo } from "../../hooks/use-model-configs.ts";
import type {
  ModelProviderCredentialInfo,
  ProviderRegistryEntry,
} from "../../hooks/use-model-provider-credentials.ts";
import type { OrgModelInfo } from "../../hooks/use-models.ts";
import { orgModelFixture as model } from "../../test/org-model-fixture.ts";
import { connectionFixture, modelConfigFixture } from "../../test/model-config-fixtures.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
});

const { OrgSettingsModelsPage } = await import("../org-settings/models.tsx");
const { PreferencesModelsPage } = await import("../preferences/models.tsx");
const { orgStore } = await import("../../stores/org-store.ts");
const { authStore } = await import("../../stores/auth-store.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const ORG_ID = "org_a";
const ME = "usr_me";
const ORG_SCOPE = { params: { header: { "X-Org-Id": ORG_ID } } };
const CREDENTIALS_PATH = "/api/model-provider-credentials";

const ANTHROPIC = {
  providerId: "anthropic",
  displayName: "Anthropic",
  iconUrl: "anthropic",
  apiShape: "anthropic-messages",
  defaultBaseUrl: "https://api.anthropic.com",
  baseUrlOverridable: false,
  authMode: "api_key",
  featured: true,
  live_model_search: false,
  models: [{ id: "claude-sonnet-4-5", featured: true }],
} as unknown as ProviderRegistryEntry;

const SERVED = modelConfigFixture();
const UNSERVED = modelConfigFixture({
  id: "cfg_2",
  provider_id: "mistral",
  provider_name: "Mistral",
  label: "Mistral",
  org_connection: "none",
  personal_connections_allowed: false,
  accepts: [{ provider_id: "anthropic", display_name: "Anthropic", auth_mode: "api_key" }],
});
const SONNET = model({ id: "mdl_sonnet", label: "Claude Sonnet", is_default: true });
const SYSTEM = model({
  id: "mdl_sys",
  label: "Modèle système",
  source: "built-in",
  config_id: null,
  billed_to: "system",
});

const MEMBER = ["models:read"];
const ADMIN = [
  "models:read",
  "models:write",
  "models:delete",
  "model-provider-credentials:read",
  "model-provider-credentials:write",
  "model-provider-credentials:connect",
];

/** Every `enabled` an observer registered for `path`, in render order. */
function observerEnabledFlags(cache: QueryCache, path: string): unknown[] {
  const flags: unknown[] = [];
  const build = cache.build.bind(cache);
  spyOn(cache, "build").mockImplementation((client, options, state) => {
    if (options.queryKey[1] === path) flags.push((options as { enabled?: unknown }).enabled);
    return build(client, options, state);
  });
  return flags;
}

function renderPage(
  page: "settings" | "preferences",
  permissions: string[],
  data: {
    configs?: ModelConfigInfo[];
    models?: OrgModelInfo[];
    credentials?: ModelProviderCredentialInfo[];
  } = {},
): { html: string; credentialFlags: unknown[] } {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  queryClient.setQueryData(
    ["orgs"],
    [
      {
        id: ORG_ID,
        name: "Acme",
        slug: "acme",
        role: permissions.length > 1 ? "admin" : "member",
        permissions,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
  );
  queryClient.setQueryData(["get", "/api/model-configs", ORG_SCOPE], {
    data: data.configs ?? [SERVED, UNSERVED],
  });
  queryClient.setQueryData(["get", "/api/models", ORG_SCOPE], {
    data: data.models ?? [SONNET, SYSTEM],
  });
  queryClient.setQueryData(["get", CREDENTIALS_PATH, ORG_SCOPE], {
    data: data.credentials ?? [connectionFixture()],
  });
  queryClient.setQueryData(["get", "/api/model-provider-credentials/registry", ORG_SCOPE], {
    data: [ANTHROPIC],
  });
  const credentialFlags = observerEnabledFlags(queryClient.getQueryCache(), CREDENTIALS_PATH);
  const orgSnapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  const authSnapshot = spyOn(authStore, "getInitialState").mockReturnValue({
    ...authStore.getInitialState(),
    user: { id: ME, email: "me@example.com", emailVerified: true },
  });
  try {
    const Page = page === "settings" ? OrgSettingsModelsPage : PreferencesModelsPage;
    return { html: render(<Page />, { queryClient }), credentialFlags };
  } finally {
    orgSnapshot.mockRestore();
    authSnapshot.mockRestore();
  }
}

/** The first row (`data-row`) holding `text`, up to the next row. */
function rowOf(html: string, text: string): string {
  const rows = html.split('data-row="true"').slice(1);
  const row = rows.find((candidate) => candidate.includes(text));
  if (row === undefined) throw new Error(`no row holds "${text}"`);
  return row;
}

describe("Settings › Models, for a member who may only read models", () => {
  const { html, credentialFlags } = renderPage("settings", MEMBER);

  it("registers no enabled observer on the connections", () => {
    expect(credentialFlags.filter((enabled) => enabled !== false)).toEqual([]);
  });

  it("reads the default model as text, with no picker and no Actions menu", () => {
    expect(html).toContain(settingsFr["modelConfigs.default.label"]);
    expect(html).toContain(SONNET.label);
    expect(html).not.toContain('role="combobox"');
    expect(html).not.toContain("data-page-actions-trigger");
  });

  it("lists every configuration with its state, and the instance's models last", () => {
    expect(rowOf(html, "Anthropic")).toContain(settingsFr["modelConfigs.state.active"]);
    expect(rowOf(html, "Mistral")).toContain(settingsFr["modelConfigs.state.connect"]);
    const systemAt = html.indexOf(settingsFr["modelConfigs.system.label"]);
    expect(systemAt).toBeGreaterThan(html.indexOf("Mistral"));
    expect(html).toContain(settingsFr["modelConfigs.state.system"]);
    expect(html).toContain(SYSTEM.label);
  });

  it("offers no repair to a member who may not connect", () => {
    expect(rowOf(html, "Mistral")).not.toContain(`>${settingsFr["modelConfigs.connect.action"]}<`);
  });
});

describe("Settings › Models, for an administrator", () => {
  const { html, credentialFlags } = renderPage("settings", ADMIN);

  it("reads the connections, so the gate is the permission", () => {
    expect(credentialFlags.length).toBeGreaterThan(0);
    expect(credentialFlags.every((enabled) => enabled === true)).toBe(true);
  });

  it("chooses the default in a picker, and adds a configuration from the Actions menu", () => {
    expect(html).toContain('role="combobox"');
    expect(html).toContain("data-page-actions-trigger");
  });

  it("offers « Connecter » on a configuration no organization connection serves", () => {
    expect(rowOf(html, "Mistral")).toContain(`>${settingsFr["modelConfigs.connect.action"]}<`);
    expect(rowOf(html, "Anthropic")).not.toContain(
      `>${settingsFr["modelConfigs.connect.action"]}<`,
    );
  });

  it("summarises a configuration on one line", () => {
    const row = rowOf(html, "Anthropic");
    expect(row).toContain("1 modèle");
    expect(row).toContain(settingsFr["modelConfigs.summary.orgConnection"]);
    expect(row).toContain("0 connexion perso");
  });

  it("says when there is no configuration yet, with the way to add one", () => {
    const empty = renderPage("settings", ADMIN, { configs: [], models: [SYSTEM] }).html;
    expect(empty).toContain(settingsFr["modelConfigs.empty"]);
    expect(empty).toContain(settingsFr["modelConfigs.add.action"]);
  });
});

describe("Preferences › Models", () => {
  it("lists only the configurations open to personal connections", () => {
    const { html } = renderPage("preferences", ADMIN);
    expect(html).toContain("Anthropic");
    expect(html).not.toContain("Mistral");
  });

  it("says the organization's connection serves the caller, and offers their own key", () => {
    const { html } = renderPage("preferences", ADMIN);
    expect(html).toContain(settingsFr["modelConfigs.preferences.servedByOrg"]);
    expect(html).toContain(settingsFr["modelConfigs.preferences.useMine"]);
  });

  it("names the caller's own connection once they have one", () => {
    const mine = connectionFixture({
      id: "cred_me",
      label: "Ma clé",
      owner_type: "user",
      owner_id: ME,
      owner_name: "Moi",
    });
    const { html } = renderPage("preferences", ADMIN, { credentials: [mine] });
    expect(html).toContain(
      settingsFr["modelConfigs.preferences.servedByMine"].replace("{{account}}", "Ma clé"),
    );
    expect(html).not.toContain(settingsFr["modelConfigs.preferences.useMine"]);
  });

  it("says nobody serves the caller when the organization has no connection", () => {
    const { html } = renderPage("preferences", ADMIN, {
      configs: [{ ...SERVED, org_connection: "none" }],
      credentials: [],
    });
    expect(html).toContain(settingsFr["modelConfigs.preferences.servedByNone"]);
  });
});
