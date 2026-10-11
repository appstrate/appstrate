// SPDX-License-Identifier: Apache-2.0

/**
 * The models page as an administrator reads it: ONE table grouped by provider,
 * then the models each person serves with their own provider, then the system's;
 * and the caller's own providers table (Preferences), with every deed in the
 * row's menu.
 *
 * A row carries no marker of its own (the tables are `DataTable`s), so a row is
 * read from its label to the next row.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";
import settingsFr from "../../locales/fr/settings.json";
import type { ModelProviderCredentialInfo } from "../../hooks/use-model-provider-credentials.ts";
import type { OrgModelInfo } from "../../hooks/use-models.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
});

const { ModelsTable, MemberProvidersTable } = await import("../org-settings/models.tsx");
const { CredentialsSection } = await import("../../components/model-credentials-section.tsx");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const REGISTRY_KEY = [
  "get",
  "/api/model-provider-credentials/registry",
  { params: { header: { "X-Org-Id": undefined } } },
];

function seededClient(): QueryClient {
  const qc = new QueryClient();
  qc.setQueryData(REGISTRY_KEY, { data: [] });
  return qc;
}

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
    allowed_actions: ["edit", "delete", "test"],
    bindable: true,
    needs_reconnection: false,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...over,
  };
}

const ORG_KEY = credential({});
const EMPTY_KEY = credential({ id: "cred_empty", label: "Clé sans modèle" });
const BOB_SUBSCRIPTION = credential({
  id: "cred_bob",
  label: "Abonnement principal",
  providerId: "claude-code",
  authMode: "oauth2",
  oauth_email: "bob@example.com",
  owner_type: "user",
  owner_id: "usr_bob",
  owner_name: "Bob",
  created_by: "usr_bob",
  allowed_actions: ["edit", "delete", "test"],
  bindable: false,
});
const ALICE_SUBSCRIPTION = credential({
  ...BOB_SUBSCRIPTION,
  id: "cred_alice",
  label: "Abonnement secondaire",
  oauth_email: "alice@example.com",
  owner_id: "usr_alice",
  owner_name: "Alice",
  created_by: "usr_alice",
  allowed_actions: [],
});

/** The table row holding `text`, up to the next row, so a cell is read off its own row. */
function rowOf(html: string, text: string): string {
  const at = html.indexOf(text);
  if (at === -1) throw new Error(`no row holds "${text}"`);
  const next = html.indexOf("<tr", at);
  return html.slice(html.lastIndexOf("<tr", at), next === -1 ? undefined : next);
}

/** What a cell shows when its label can be renamed in place. */
const RENAMABLE = "cursor-pointer";

const model = (over: Partial<OrgModelInfo>): OrgModelInfo => ({
  id: "mdl_1",
  label: "Claude Sonnet",
  apiShape: "anthropic-messages",
  providerId: "anthropic",
  provider_name: "Anthropic",
  pi_provider: "anthropic",
  pi_dialect: null,
  base_url: "https://api.anthropic.com",
  modelId: "claude-sonnet-4-5",
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
});

const noop = () => {};
function modelsTable(
  models: OrgModelInfo[],
  credentials: ModelProviderCredentialInfo[] | undefined,
  over: { canWrite?: boolean } = {},
): string {
  const canWrite = over.canWrite ?? false;
  return render(
    <ModelsTable
      models={models}
      credentials={credentials}
      isLoading={false}
      error={null}
      onCreateModel={noop}
      onCreateProvider={noop}
      onAddModelTo={noop}
      onEditModel={noop}
      onEditProvider={noop}
      onDeleteModel={noop}
      onDeleteProvider={noop}
      onSetDefault={noop}
      onRenameModel={async () => {}}
      onRenameProvider={async () => {}}
      onToggleEnabled={noop}
      settingDefaultId={null}
      togglingId={null}
      canWriteModels={canWrite}
      canDeleteModels={false}
      canWriteProviders={canWrite}
    />,
    { queryClient: seededClient() },
  );
}

describe("the models table, grouped by provider", () => {
  const bound = model({ id: "mdl_bound", label: "Sonnet lié" });
  const personal = model({
    id: "mdl_each",
    label: "Sonnet des membres",
    binding: "member",
    credentialId: null,
    billed_to: null,
  });
  const system = model({
    id: "mdl_sys",
    label: "Modèle système",
    source: "built-in",
    credentialId: null,
    billed_to: "system",
  });
  const html = modelsTable([bound, personal, system], [ORG_KEY, EMPTY_KEY, BOB_SUBSCRIPTION], {
    canWrite: true,
  });

  it("opens with the organization's provider, its model under it", () => {
    expect(html.indexOf(ORG_KEY.label)).toBeLessThan(html.indexOf(bound.label));
    expect(html.indexOf(bound.label)).toBeLessThan(
      html.indexOf(settingsFr["models.group.personal"]),
    );
  });

  it("names the group of models each person serves with their own provider, and their service", () => {
    expect(html).toContain(settingsFr["models.group.personal"]);
    expect(html).toContain(settingsFr["models.group.personalHint"]);
    expect(rowOf(html, personal.label)).toContain("Anthropic");
  });

  it("ends with the system's models", () => {
    expect(html.indexOf(settingsFr["models.group.system"])).toBeGreaterThan(
      html.indexOf(personal.label),
    );
    expect(html).toContain(system.label);
  });

  it("never draws a member's own provider as a group of the organization", () => {
    expect(html).not.toContain(BOB_SUBSCRIPTION.label);
  });

  it("gives a provider with no model a line to add one", () => {
    expect(html).toContain(EMPTY_KEY.label);
    expect(html.slice(html.indexOf(EMPTY_KEY.label))).toContain(settingsFr["models.add"]);
  });

  it("lets the folds be asked for by name", () => {
    expect(html).toContain('aria-expanded="true"');
  });

  it("drops the pencil from the rows: every deed is in the menu", () => {
    expect(html).not.toContain(`title="${settingsFr["models.edit"]}"`);
  });
});

describe("the models table, for a caller who cannot read the organization's providers", () => {
  const bound = model({ id: "mdl_bound", label: "Sonnet lié" });
  const html = modelsTable([bound], undefined);

  it("groups the model under the service it runs on", () => {
    expect(rowOf(html, "Anthropic")).toContain("Anthropic");
    expect(html.indexOf("Anthropic")).toBeLessThan(html.indexOf(bound.label));
  });

  it("offers no line to add a model", () => {
    expect(html).not.toContain(settingsFr["models.add"]);
  });
});

describe("the models table, when it is empty", () => {
  it("offers the add buttons to someone who may add, and not to anyone else", () => {
    // The Actions menu is closed in a static render: these buttons are the empty state's.
    const writer = modelsTable([], [], { canWrite: true });
    expect(writer).toContain(settingsFr["credentials.add"]);
    expect(writer).toContain(settingsFr["models.add"]);
    const reader = modelsTable([], []);
    expect(reader).toContain(settingsFr["models.empty"]);
    expect(reader).not.toContain(settingsFr["models.add"]);
  });
});

describe("the members' providers, as an administrator reads them", () => {
  const html = render(
    <MemberProvidersTable
      credentials={[ORG_KEY, BOB_SUBSCRIPTION, ALICE_SUBSCRIPTION]}
      isLoading={false}
      error={null}
    />,
    { queryClient: seededClient() },
  );

  it("lists the members' providers only, with their holder", () => {
    expect(html).not.toContain(ORG_KEY.label);
    expect(rowOf(html, BOB_SUBSCRIPTION.label)).toContain("Bob");
    expect(rowOf(html, ALICE_SUBSCRIPTION.label)).toContain("Alice");
  });

  it("changes nothing: no rename, and a test only where the server allows it", () => {
    expect(html).not.toContain(RENAMABLE);
    const menu = (pk: ModelProviderCredentialInfo) =>
      settingsFr["credentials.moreActions"].replace("{{name}}", pk.label);
    expect(rowOf(html, BOB_SUBSCRIPTION.label)).toContain(menu(BOB_SUBSCRIPTION));
    expect(rowOf(html, ALICE_SUBSCRIPTION.label)).not.toContain(menu(ALICE_SUBSCRIPTION));
  });
});

describe("the caller's own providers table", () => {
  const section = (credentials: ModelProviderCredentialInfo[], onAdd?: () => void) =>
    render(
      <CredentialsSection
        credentials={credentials}
        isLoading={false}
        error={null}
        onEdit={noop}
        onDelete={noop}
        onRename={async () => {}}
        onConnectOAuth={noop}
        onAdd={onAdd}
        empty={{ message: settingsFr["modelCredentials.empty"] }}
      />,
      { queryClient: seededClient() },
    );

  it("lets the holder rename a provider where the server allows it, and nobody else", () => {
    const html = section([BOB_SUBSCRIPTION, ALICE_SUBSCRIPTION]);
    expect(rowOf(html, BOB_SUBSCRIPTION.label)).toContain(RENAMABLE);
    expect(rowOf(html, ALICE_SUBSCRIPTION.label)).not.toContain(RENAMABLE);
  });

  it("offers the add button to someone who may add, and not to anyone else", () => {
    expect(section([], () => {})).toContain(settingsFr["credentials.add"]);
    expect(section([])).toContain(settingsFr["modelCredentials.empty"]);
    expect(section([])).not.toContain(settingsFr["credentials.add"]);
  });
});
