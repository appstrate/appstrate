// SPDX-License-Identifier: Apache-2.0

/**
 * The two tables of the models page as an administrator reads them: who owns
 * each credential, which of them the caller may change, and which credential a
 * model names — or that it names none, because each member brings their own.
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

const { ModelsList } = await import("../org-settings/models.tsx");
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
    allowed_actions: ["edit", "delete"],
    bindable: true,
    needs_reconnection: false,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...over,
  };
}

const ORG_KEY = credential({});
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

function credentialsPage(credentials: ModelProviderCredentialInfo[]): string {
  return render(
    <CredentialsSection
      credentials={credentials}
      isLoading={false}
      error={null}
      onCreate={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
      onConnectOAuth={() => {}}
      canAdd
      showOwner
    />,
    { queryClient: seededClient() },
  );
}

/** One table row, from its marker to the next row, so a cell is read off its own row. */
function rowOf(html: string, marker: string): string {
  const start = html.indexOf(marker);
  const next = html.indexOf("<tr", start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

describe("the credentials table, as Bob sees it", () => {
  const html = credentialsPage([ORG_KEY, BOB_SUBSCRIPTION, ALICE_SUBSCRIPTION]);
  const row = (id: string) => rowOf(html, `data-testid="credential-row-${id}"`);

  it("names the organization for an organization credential", () => {
    expect(row(ORG_KEY.id)).toContain(`>${settingsFr["source.org"]}<`);
  });

  it("names the holder for a personal credential", () => {
    expect(row(BOB_SUBSCRIPTION.id)).toContain(">Bob<");
    expect(row(ALICE_SUBSCRIPTION.id)).toContain(">Alice<");
  });

  it("lets Bob rename his own subscription, and not Alice's", () => {
    const edit = `aria-label="${settingsFr["credentials.edit"]}"`;
    expect(row(BOB_SUBSCRIPTION.id)).toContain(edit);
    expect(row(ALICE_SUBSCRIPTION.id)).not.toContain(edit);
  });

  it("lets the organization credential be renamed where the server allows it", () => {
    expect(row(ORG_KEY.id)).toContain(`aria-label="${settingsFr["credentials.edit"]}"`);
  });
});

describe("the credentials table, where a subscription needs reconnecting", () => {
  const html = credentialsPage([
    {
      ...BOB_SUBSCRIPTION,
      needs_reconnection: true,
      allowed_actions: ["edit", "delete", "reconnect"],
    },
    { ...ALICE_SUBSCRIPTION, needs_reconnection: true, allowed_actions: [] },
  ]);
  const row = (id: string) => rowOf(html, `data-testid="credential-row-${id}"`);

  it("offers the reconnect to the holder only", () => {
    expect(row(BOB_SUBSCRIPTION.id)).toContain(settingsFr["credentials.oauth.reconnect"]);
    expect(row(ALICE_SUBSCRIPTION.id)).not.toContain(settingsFr["credentials.oauth.reconnect"]);
  });
});

describe("the models table, for the credential each model names", () => {
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
  const bound = model({ id: "mdl_bound" });
  const unbound = model({
    id: "mdl_each",
    binding: "member",
    credentialId: null,
    billed_to: null,
  });
  const html = render(
    <ModelsList
      models={[bound, unbound]}
      isLoading={false}
      error={null}
      onCreate={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
      onSetDefault={() => {}}
      canWrite={false}
      canDelete={false}
      credentialLabels={new Map([["cred_org", "Clé équipe"]])}
    />,
    { queryClient: seededClient() },
  );
  const row = (id: string) => rowOf(html, `data-testid="model-row-${id}"`);

  it("names the organization credential a model is bound to", () => {
    expect(row(bound.id)).toContain("Clé équipe");
  });

  it("says that each member brings their own credential, for an unbound model", () => {
    expect(row(unbound.id)).toContain(settingsFr["models.credentialEachMember"]);
  });
});
