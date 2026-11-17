// SPDX-License-Identifier: Apache-2.0

/**
 * The edit form of a saved model: which credential serves it, its id, its name and its
 * capabilities. Only two registry facts move anything: `authMode` decides whether the credential
 * is a key or a connection, and the catalog decides whether the capabilities toggle opens on, i.e.
 * whether this row has overridden its catalog entry.
 *
 * `ModelFormBody` is rendered rather than `ModelFormModal` because the dialog chrome is a Radix
 * portal, which renders nothing at all without a DOM — and the web runner has none. Select ITEMS
 * are portalled too, so which credentials the picker offers is asserted on
 * `lib/test/model-credential-filter.test.ts`, and the payload on `lib/test/model-form-payload.test.ts`.
 */

import { describe, it, expect } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import i18n, { i18nReady } from "../../i18n.ts";
import settingsFr from "../../locales/fr/settings.json";
import { render } from "../../test/render.tsx";
import { ModelFormBody } from "../model-form-modal.tsx";
import type {
  ModelProviderCredentialInfo,
  ProviderRegistryEntry,
} from "../../hooks/use-model-provider-credentials.ts";
import type { OrgModelInfo } from "../../hooks/use-models.ts";
import { UNKNOWN_MODEL_GENERATION_CAPABILITIES } from "@appstrate/core/model-generation";

await i18nReady;
await i18n.changeLanguage("fr");

/**
 * openapi-react-query keys are `[method, path, init]`, and both hooks pass the
 * org header explicitly (`useOrgOnlyScope`). No org is selected in the runner,
 * so the header value is `undefined` — mirrored here so the seeded entry is the
 * one the hook reads.
 */
const ORG_SCOPE = { params: { header: { "X-Org-Id": undefined } } };
const REGISTRY_KEY = ["get", "/api/model-provider-credentials/registry", ORG_SCOPE];
const CREDENTIALS_KEY = ["get", "/api/model-provider-credentials", ORG_SCOPE];

const OPENAI_COMPATIBLE: ProviderRegistryEntry = {
  providerId: "openai-compatible",
  displayName: "OpenAI-compatible (custom)",
  iconUrl: "openai",
  description: null,
  docsUrl: null,
  apiShape: "openai-completions",
  defaultBaseUrl: "http://localhost:11434",
  baseUrlOverridable: true,
  authMode: "api_key",
  featured: false,
  live_model_search: false,
  models: [],
  personal_allowed: false,
};

/** The catalog entry every "does this row override it?" case is measured against. */
const SONNET = {
  id: "claude-sonnet-4-5-20250929",
  label: "Claude Sonnet 4.5",
  featured: true,
  contextWindow: 200000,
  maxTokens: 64000,
  capabilities: ["text", "image", "reasoning"],
  generation: UNKNOWN_MODEL_GENERATION_CAPABILITIES,
  cost: { input: 3, output: 15 },
};

const ANTHROPIC: ProviderRegistryEntry = {
  providerId: "anthropic",
  displayName: "Anthropic",
  iconUrl: "anthropic",
  description: null,
  docsUrl: null,
  apiShape: "anthropic-messages",
  defaultBaseUrl: "https://api.anthropic.com",
  baseUrlOverridable: false,
  authMode: "api_key",
  featured: true,
  live_model_search: false,
  models: [SONNET],
  personal_allowed: true,
};

/** A subscription provider: same catalog, opened by a connection, not a key. */
const CLAUDE_CODE: ProviderRegistryEntry = {
  ...ANTHROPIC,
  providerId: "claude-code",
  displayName: "Claude Code",
  authMode: "oauth2",
};

/** The row's binding follows its credential, as the server projects it: unbound is `user`. */
function model(overrides: Partial<OrgModelInfo>): OrgModelInfo {
  const credentialId = overrides.credentialId === undefined ? "cred_1" : overrides.credentialId;
  return {
    id: "mdl_1",
    label: "Local Qwen",
    apiShape: "openai-completions",
    providerId: "openai-compatible",
    provider_name: "OpenAI-compatible (custom)",
    pi_provider: null,
    pi_dialect: null,
    base_url: "http://localhost:11434/v1",
    modelId: "qwen3:8b",
    generation: null,
    enabled: true,
    is_default: false,
    needs_reconnection: false,
    aliased: false,
    iconUrl: null,
    source: "custom",
    binding: credentialId === null ? "user" : "org",
    credentialId,
    billed_to: "org",
    created_by: null,
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:00:00.000Z",
    ...overrides,
  };
}

/** A catalogued row as `GET /api/models` returns it: RESOLVED from the catalog. */
function catalogued(overrides: Partial<OrgModelInfo> = {}): OrgModelInfo {
  return model({
    label: "Claude Sonnet 4.5",
    apiShape: "anthropic-messages",
    providerId: "anthropic",
    provider_name: "Anthropic",
    pi_provider: "anthropic",
    pi_dialect: null,
    base_url: "https://api.anthropic.com",
    modelId: SONNET.id,
    credentialId: "cred_ant",
    input: ["text", "image"],
    contextWindow: SONNET.contextWindow,
    maxTokens: SONNET.maxTokens,
    reasoning: true,
    ...overrides,
  });
}

/** The key the edited row is bound to. Every custom credential names the
 *  provider it was created for, which is what an overridable one is matched on. */
const LOCAL_KEY: ModelProviderCredentialInfo = {
  id: "cred_1",
  label: "localhost:11434 · OpenAI-compatible",
  apiShape: "openai-completions",
  base_url: "http://localhost:11434/v1",
  providerId: "openai-compatible",
  source: "custom",
  authMode: "api_key",
  owner_type: "org",
  owner_id: null,
  owner_name: null,
  created_by: null,
  allowed_actions: ["edit", "delete", "test"],
  bindable: true,
  serves_model_ids: [],
  createdAt: "2026-07-01T10:00:00.000Z",
  updatedAt: "2026-07-01T10:00:00.000Z",
};

/** The same provider, saved against another host — E1's whole point. */
const REMOTE_KEY: ModelProviderCredentialInfo = {
  ...LOCAL_KEY,
  id: "cred_2",
  label: "vllm.internal · OpenAI-compatible",
  base_url: "https://vllm.internal/v1",
};

/** A pinned provider matches its keys on the endpoint, not on the provider id. */
const ANTHROPIC_KEY: ModelProviderCredentialInfo = {
  ...LOCAL_KEY,
  id: "cred_ant",
  label: "Anthropic",
  apiShape: "anthropic-messages",
  base_url: "https://api.anthropic.com",
  providerId: "anthropic",
};

/** A member's personal subscription: no organization model can bind it. */
const CONNECTION: ModelProviderCredentialInfo = {
  ...ANTHROPIC_KEY,
  id: "cred_cc",
  label: "Claude Code",
  providerId: "claude-code",
  authMode: "oauth2",
  oauth_email: "dev@example.com",
  owner_type: "user",
  owner_id: "usr_1",
  owner_name: "Alice",
  allowed_actions: ["edit", "delete", "reconnect"],
  bindable: false,
};

/** A subscription the organization connected: bindable like an organization key. */
const ORG_CONNECTION: ModelProviderCredentialInfo = {
  ...CONNECTION,
  id: "cred_cc_org",
  label: "Abonnement de l'équipe",
  oauth_email: "team@example.com",
  owner_type: "org",
  owner_id: null,
  owner_name: null,
  bindable: true,
  serves_model_ids: [],
};

function form(target: OrgModelInfo, credentials: ModelProviderCredentialInfo[] = []): string {
  const qc = new QueryClient();
  qc.setQueryData(REGISTRY_KEY, { data: [ANTHROPIC, CLAUDE_CODE, OPENAI_COMPATIBLE] });
  qc.setQueryData(CREDENTIALS_KEY, { data: credentials });
  return render(<ModelFormBody model={target} onSubmit={async () => {}} />, { queryClient: qc });
}

describe("ModelFormBody — editing a custom endpoint", () => {
  // A saved row carries a capability no catalog claims, so the toggle opens on.
  const html = form(model({ contextWindow: 32768 }), [LOCAL_KEY]);

  it("asks which key serves the model, with no endpoint to describe", () => {
    expect(html).toContain('id="mdl-credential"');
    expect(html).toContain(settingsFr["credentials.form.apiKey"]);
    for (const absent of ['id="mdl-provider"', 'id="mdl-apiType"', 'id="mdl-baseUrl"'])
      expect(html).not.toContain(absent);
    expect(html).not.toContain('placeholder="sk-..."');
    // The key it names is among those it may bind: nothing to ask again.
    expect(html).not.toContain(settingsFr["models.form.chooseIdentity"]);
  });

  it("opens on the model the row already names, editable and free-text", () => {
    expect(html).toContain('id="mdl-modelId"');
    expect(html).toContain('id="mdl-label"');
    // The name is required on a saved row: PATCH reads an absent one as "keep",
    // so promising a derived one would describe a save that changes nothing.
    expect(html).not.toContain(settingsFr["models.form.labelPlaceholder"]);
  });

  it("opens the capabilities on the row's own values, the toggle already on", () => {
    // No catalog entry claims `qwen3:8b`, so the 32768 can only be an answer
    // the operator gave.
    expect(checkedState(html, "mdl-capabilities-explicit")).toBe("true");
    for (const id of [
      "mdl-ctx",
      "mdl-maxtok",
      "mdl-input-text",
      "mdl-input-image",
      "mdl-reasoning",
    ])
      expect(html).toContain(`id="${id}"`);
    expect(html).not.toContain(settingsFr["models.form.capabilitiesAuto"]);
  });

  it("offers no listing: that adds rows, and an edit changes this one", () => {
    expect(html).not.toContain(settingsFr["models.form.discoverButton"]);
    expect(html).not.toContain('id="mdl-pick-all"');
  });

  it("orders the fields the way they are filled in", () => {
    // credential → the model → its name → capabilities.
    const order = [
      'id="mdl-credential"',
      'id="mdl-modelId"',
      'id="mdl-label"',
      'id="mdl-capabilities-explicit"',
    ].map((marker) => html.indexOf(marker));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("ModelFormBody — a key the model can no longer bind", () => {
  // The row names a key that is not in the list: the picker asks again.
  const html = form(model({ credentialId: "cred_gone" }), [REMOTE_KEY]);

  it("asks for a key again, and keeps the rest of the form editable", () => {
    expect(html).toContain(settingsFr["models.form.chooseIdentity"]);
    expect(html).toContain('id="mdl-modelId"');
  });
});

describe("ModelFormBody — editing a catalogued row that overrides nothing", () => {
  const html = form(catalogued(), [ANTHROPIC_KEY]);

  it("shows the model as a plain editable id, with no key to type", () => {
    expect(html).toContain('id="mdl-modelId"');
    expect(html).toContain('id="mdl-label"');
    expect(html).not.toContain('placeholder="sk-..."');
  });

  it("leaves the capabilities toggle off, because the row equals its catalog entry", () => {
    // `GET /api/models` resolves these from the catalog, so reading "carries a
    // number" as "overrides" would freeze the catalog's own values on the next
    // save and stop a catalog update (a Pi bump) reaching the row.
    expect(checkedState(html, "mdl-capabilities-explicit")).toBe("false");
    expect(html).toContain(settingsFr["models.form.capabilitiesAuto"]);
    expect(html).not.toContain('id="mdl-ctx"');
  });
});

describe("ModelFormBody — editing a catalogued row that does override it", () => {
  const html = form(catalogued({ contextWindow: 32768 }), [ANTHROPIC_KEY]);

  it("opens the toggle on, because the row disagrees with the catalog", () => {
    expect(checkedState(html, "mdl-capabilities-explicit")).toBe("true");
    expect(html).toContain('id="mdl-ctx"');
    expect(html).not.toContain(settingsFr["models.form.capabilitiesAuto"]);
  });
});

describe("ModelFormBody — editing a subscription row the org left to each member", () => {
  const html = form(
    catalogued({
      providerId: "claude-code",
      provider_name: "Claude Code",
      credentialId: null,
    }),
    [CONNECTION],
  );

  it("says each member's own credential serves it, under the identifier label", () => {
    expect(html).toContain(settingsFr["models.form.identityLabel"]);
    expect(html).toContain(settingsFr["models.form.eachMemberHint"]);
  });

  it("offers no personal connection of a member, and asks for no key", () => {
    // A member's own subscription serves only their calls: the org model cannot bind it.
    expect(html).not.toContain(CONNECTION.oauth_email!);
    expect(html).not.toContain('placeholder="sk-..."');
  });
});

describe("ModelFormBody — editing a row bound to an organization subscription", () => {
  const bound = catalogued({
    providerId: "claude-code",
    provider_name: "Claude Code",
    credentialId: ORG_CONNECTION.id,
  });

  it("names the credential as an identifier, not each member", () => {
    const html = form(bound, [CONNECTION, ORG_CONNECTION]);
    expect(html).toContain(settingsFr["models.form.identityLabel"]);
    expect(html).not.toContain(settingsFr["models.form.eachMemberHint"]);
    expect(html).toContain('id="mdl-modelId"');
  });

  it("binds nothing to a member's personal subscription, whatever the row names", () => {
    // The server lists it as not bindable: the picker asks again.
    const personal = form({ ...bound, credentialId: CONNECTION.id }, [CONNECTION]);
    expect(personal).toContain(settingsFr["models.form.chooseIdentity"]);
  });
});

describe("ModelFormBody — catalogued row left to each member", () => {
  const html = form(catalogued({ credentialId: null }), [ANTHROPIC_KEY]);

  it("says each member's own credential serves it, and keeps the id editable", () => {
    expect(html).toContain(settingsFr["models.form.eachMemberHint"]);
    expect(html).toContain('id="mdl-modelId"');
    expect(html).not.toContain('placeholder="sk-..."');
  });
});

describe("ModelFormBody — custom endpoint is never left to each member", () => {
  // A custom endpoint is the operator's to describe, so the choice is not offered.
  const html = form(model({ credentialId: null }), [LOCAL_KEY]);

  it("asks for a key again, and says nothing of each member", () => {
    expect(html).toContain(settingsFr["models.form.chooseIdentity"]);
    expect(html).not.toContain(settingsFr["models.form.eachMemberHint"]);
  });
});

describe("ModelFormBody — editing a row whose provider left the registry", () => {
  const html = form(model({ providerId: "gone", provider_name: "Gone" }), [LOCAL_KEY]);

  it("says so, instead of an empty form whose Save reports nothing", () => {
    expect(html).toContain(settingsFr["models.form.providerUnavailable"]);
    expect(html).not.toContain('id="mdl-credential"');
    expect(html).not.toContain('id="mdl-modelId"');
    expect(html).not.toContain('id="mdl-capabilities-explicit"');
  });
});

/** A Radix checkbox is a `button`, so its state reads off `aria-checked`. */
function checkedState(html: string, id: string): string | undefined {
  const tag = html.slice(html.lastIndexOf("<button", html.indexOf(`id="${id}"`)));
  return /aria-checked="(\w+)"/.exec(tag.slice(0, tag.indexOf(">")))?.[1];
}
