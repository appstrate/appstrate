// SPDX-License-Identifier: Apache-2.0

/**
 * The providers tables as an administrator reads them: the organization's keys and the instance
 * on one tab, the services open to personal keys on the other, each row with the models it
 * makes usable and one State column. The personal kinds of key (Preferences) are the first
 * table with its Type column.
 *
 * A row carries no marker of its own (the table is a `DataTable`), so a row is read from its
 * label to the next row.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";
import settingsFr from "../../locales/fr/settings.json";
import type {
  ModelProviderCredentialInfo,
  ProviderRegistryEntry,
} from "../../hooks/use-model-provider-credentials.ts";
import type { OrgModelInfo } from "../../hooks/use-models.ts";
import { personalServiceRows, providerRows } from "../../lib/model-providers.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
});

const { ProvidersTable } = await import("../../components/providers-table.tsx");
const { PersonalServicesTable } = await import("../../components/personal-services-table.tsx");
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

/** What `providerRows` reads of the registry: the services, and what a subscription offers. */
const SERVICES = [
  {
    providerId: "anthropic",
    displayName: "Anthropic",
    authMode: "api_key",
    apiShape: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com",
    baseUrlOverridable: false,
    personal_allowed: true,
    models: [{ id: "claude-sonnet-4-5" }],
  },
  {
    providerId: "claude-code",
    displayName: "Claude Code",
    authMode: "oauth2",
    apiShape: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com",
    models: [{ id: "claude-sonnet-4-5" }],
  },
] as unknown as ProviderRegistryEntry[];

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
const MY_KEY = credential({
  id: "cred_me",
  label: "Ma clé",
  owner_type: "user",
  owner_id: "usr_me",
  owner_name: "Moi",
  bindable: false,
});
const BOB_SUBSCRIPTION = credential({
  id: "cred_bob",
  label: "Abonnement de Bob",
  providerId: "claude-code",
  authMode: "oauth2",
  oauth_email: "bob@example.com",
  owner_type: "user",
  owner_id: "usr_bob",
  owner_name: "Bob",
  bindable: false,
  allowed_actions: ["test"],
});
const DEAD_KEY = credential({
  id: "cred_dead",
  label: "Clé morte",
  needs_reconnection: true,
});
const OFF_KEY = credential({ id: "cred_off", label: "Clé éteinte" });

/** The table row holding `text`, up to the next row, so a cell is read off its own row. */
function rowOf(html: string, text: string): string {
  const at = html.indexOf(text);
  if (at === -1) throw new Error(`no row holds "${text}"`);
  const next = html.indexOf("<tr", at);
  return html.slice(html.lastIndexOf("<tr", at), next === -1 ? undefined : next);
}

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
  cost: { input: 3, output: 15 },
  created_by: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
});

const noop = () => {};
function providersTable(
  models: OrgModelInfo[],
  credentials: ModelProviderCredentialInfo[],
  over: { canWrite?: boolean; showType?: boolean } = {},
): string {
  return render(
    <ProvidersTable
      label={settingsFr["providers.tableLabel"]}
      tableId="org-providers"
      rows={providerRows(models, credentials, SERVICES, "usr_me")}
      showType={over.showType}
      isLoading={false}
      error={null}
      empty={{ message: settingsFr["providers.empty"] }}
      canWriteModels={over.canWrite ?? false}
      onRename={async () => {}}
      onChooseModels={noop}
      onChangeKey={noop}
      onReconnect={noop}
      onDelete={noop}
      onSetDefault={noop}
    />,
    { queryClient: seededClient() },
  );
}

describe("the providers table", () => {
  const html = providersTable(
    [
      model({ id: "mdl_a", label: "Claude Sonnet", is_default: true }),
      model({ id: "mdl_b", label: "Claude Opus" }),
      model({ id: "mdl_m", label: "Claude pour tous", credentialId: null, binding: "member" }),
      model({
        id: "mdl_s",
        label: "Modèle système",
        source: "built-in",
        credentialId: "cred_builtin",
      }),
      model({ id: "mdl_off", label: "Claude éteint", credentialId: "cred_off", enabled: false }),
    ],
    [
      ORG_KEY,
      EMPTY_KEY,
      DEAD_KEY,
      OFF_KEY,
      MY_KEY,
      BOB_SUBSCRIPTION,
      credential({ id: "cred_builtin", source: "built-in", providerId: null }),
    ],
  );
  const system = settingsFr["providers.type.system"];

  it("heads the columns Provider, Service, Models, State, and no Type nor owner", () => {
    for (const key of [
      "providers.col.name",
      "providers.col.provider",
      "providers.col.models",
      "providers.col.state",
    ] as const) {
      expect(html).toContain(settingsFr[key]);
    }
    expect(html).not.toContain("Appartient à");
  });

  it("names the instance's row Système, and says where its models come from", () => {
    expect(rowOf(html, system)).toContain(settingsFr["providers.instanceName"]);
  });

  it("says under the name, when asked, whether a row is a personal key or a subscription", () => {
    const typed = providersTable([], [MY_KEY, BOB_SUBSCRIPTION], { showType: true });
    expect(rowOf(typed, MY_KEY.label)).toContain(settingsFr["providers.type.personalKey"]);
    expect(rowOf(typed, BOB_SUBSCRIPTION.label)).toContain(
      settingsFr["providers.type.subscription"],
    );
  });

  it("lists the models a provider makes usable, the default one marked by a star", () => {
    const row = rowOf(html, ORG_KEY.label);
    expect(row).toContain("Claude Sonnet");
    expect(row).toContain("Claude Opus");
    expect(row).toContain("lucide-star");
    expect(rowOf(html, MY_KEY.label)).toContain("Claude pour tous");
    expect(rowOf(html, system)).toContain("Modèle système");
  });

  it("says « Aucun » for a provider with no model", () => {
    expect(rowOf(html, EMPTY_KEY.label)).toContain(settingsFr["providers.noModels"]);
  });

  it("gathers the states in one column: unavailable, default, disabled, and nothing otherwise", () => {
    expect(rowOf(html, DEAD_KEY.label)).toContain(settingsFr["models.credentialUnavailable"]);
    expect(rowOf(html, ORG_KEY.label)).toContain(`>${settingsFr["models.default"]}<`);
    expect(rowOf(html, OFF_KEY.label)).toContain(settingsFr["providers.state.disabled"]);
    const quiet = rowOf(html, EMPTY_KEY.label);
    expect(quiet).not.toContain(settingsFr["models.credentialUnavailable"]);
    expect(quiet).not.toContain(`>${settingsFr["models.default"]}<`);
    expect(quiet).not.toContain(settingsFr["providers.state.disabled"]);
    // The state is said once, never repeated as a badge beside the name.
    expect(
      rowOf(html, DEAD_KEY.label).split(settingsFr["models.credentialUnavailable"]),
    ).toHaveLength(2);
  });

  it("gives the holder's rows a menu, and another person's subscription a test only", () => {
    const menu = (label: string) =>
      `aria-label="${settingsFr["providers.moreActions"].replace("{{name}}", label)}"`;
    expect(rowOf(html, ORG_KEY.label)).toContain(menu(ORG_KEY.label));
    expect(rowOf(html, BOB_SUBSCRIPTION.label)).toContain(menu(BOB_SUBSCRIPTION.label));
  });

  it("does not rename by a click on the name, nor draw a pencil", () => {
    expect(rowOf(html, ORG_KEY.label)).not.toContain("cursor-pointer");
    expect(rowOf(html, ORG_KEY.label)).not.toContain("lucide-pencil");
  });
});

describe("a click on a row", () => {
  it("chooses the models of an organization key, for a caller who may write models", () => {
    const writer = providersTable([], [ORG_KEY], { canWrite: true });
    expect(rowOf(writer, ORG_KEY.label)).toContain(`aria-label="${ORG_KEY.label}"`);
    const reader = providersTable([], [ORG_KEY], { canWrite: false });
    expect(rowOf(reader, ORG_KEY.label)).not.toContain(`aria-label="${ORG_KEY.label}"`);
  });

  it("leads nowhere from a personal key", () => {
    const html = providersTable([], [MY_KEY], { canWrite: true });
    expect(rowOf(html, MY_KEY.label)).not.toContain(`aria-label="${MY_KEY.label}"`);
  });
});

describe("an organization subscription", () => {
  const ORG_SUBSCRIPTION = credential({
    id: "cred_org_sub",
    label: "Abonnement équipe",
    providerId: "claude-code",
    authMode: "oauth2",
    oauth_email: "team@example.com",
    needs_reconnection: true,
    allowed_actions: ["reconnect"],
  });
  const menu = `aria-label="${settingsFr["providers.moreActions"].replace("{{name}}", ORG_SUBSCRIPTION.label)}"`;

  it("is an organization key: it serves the models bound to it, not the ones left to members", () => {
    const [row] = providerRows(
      [
        model({ id: "mdl_bound", label: "Claude lié", credentialId: ORG_SUBSCRIPTION.id }),
        model({ id: "mdl_m", label: "Claude pour tous", credentialId: null, binding: "member" }),
      ],
      [ORG_SUBSCRIPTION],
      SERVICES,
      "usr_me",
    );
    expect(row?.kind).toBe("org-key");
    expect(row?.models.map((m) => m.id)).toEqual(["mdl_bound"]);
  });

  it("offers the reconnect where the server lists it, with the row unavailable", () => {
    const row = rowOf(providersTable([], [ORG_SUBSCRIPTION]), ORG_SUBSCRIPTION.label);
    expect(row).toContain(menu);
    expect(row).toContain(settingsFr["models.credentialUnavailable"]);
  });

  it("withholds it from a reader the server does not allow, with the state still shown", () => {
    const row = rowOf(
      providersTable([], [{ ...ORG_SUBSCRIPTION, allowed_actions: [] }]),
      ORG_SUBSCRIPTION.label,
    );
    expect(row).not.toContain(menu);
    expect(row).toContain(settingsFr["models.credentialUnavailable"]);
  });

  it("offers no reconnect while it is healthy", () => {
    const row = rowOf(
      providersTable([], [{ ...ORG_SUBSCRIPTION, needs_reconnection: false }]),
      ORG_SUBSCRIPTION.label,
    );
    expect(row).not.toContain(menu);
  });
});

describe("the personal keys table", () => {
  const personalHtml = (
    models: OrgModelInfo[],
    credentials: ModelProviderCredentialInfo[],
    canWrite = false,
  ) =>
    render(
      <PersonalServicesTable
        rows={personalServiceRows(models, credentials, SERVICES, "usr_me")}
        isLoading={false}
        error={null}
        canWriteModels={canWrite}
        onChooseModels={noop}
      />,
      { queryClient: seededClient() },
    );
  const MEMBER_MODEL = model({
    id: "mdl_m",
    label: "Claude pour tous",
    credentialId: null,
    binding: "member",
  });
  const html = personalHtml([MEMBER_MODEL], [MY_KEY, BOB_SUBSCRIPTION]);

  it("heads the columns Service, Models, Connected keys, State", () => {
    for (const key of [
      "providers.col.provider",
      "providers.col.models",
      "providers.col.keys",
      "providers.col.state",
    ] as const) {
      expect(html).toContain(settingsFr[key]);
    }
  });

  it("makes a row of each service open to personal keys, with its models and who plugged in", () => {
    const row = rowOf(html, "Anthropic");
    expect(row).toContain("Claude pour tous");
    expect(row).toContain("Moi (vous), Bob");
  });

  it("says « Aucune clé connectée » where nobody plugged a key in", () => {
    const row = rowOf(personalHtml([MEMBER_MODEL], []), "Anthropic");
    expect(row).toContain(settingsFr["providers.noKeys"]);
    expect(row).toContain(settingsFr["providers.state.noKey"]);
    expect(rowOf(html, "Anthropic")).not.toContain(settingsFr["providers.state.noKey"]);
  });

  it("gives a caller who may write models the menu and the click, a reader neither", () => {
    const writer = personalHtml([MEMBER_MODEL], [], true);
    expect(rowOf(writer, "Anthropic")).toContain(
      `aria-label="${settingsFr["providers.moreActions"].replace("{{name}}", "Anthropic")}"`,
    );
    expect(rowOf(writer, "Anthropic")).toContain(`aria-label="Anthropic"`);
    expect(rowOf(html, "Anthropic")).not.toContain(`aria-label="Anthropic"`);
    expect(rowOf(html, "Anthropic")).not.toContain(
      settingsFr["providers.moreActions"].slice(0, 12),
    );
  });
});
