// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type {
  ModelProviderCredentialInfo,
  ProviderRegistryEntry,
} from "../../hooks/use-model-provider-credentials.ts";
import type { OrgModelInfo } from "../../hooks/use-models.ts";
import {
  personalServiceRows,
  providerRows,
  providersOpenToPersonalKeys,
  rowStates,
} from "../model-providers.ts";

const CREATED = "2026-07-01T10:00:00.000Z";

function provider(over: Partial<ProviderRegistryEntry> & { providerId: string }) {
  return {
    displayName: over.providerId,
    iconUrl: over.providerId,
    apiShape: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com",
    baseUrlOverridable: false,
    authMode: "api_key",
    featured: false,
    live_model_search: false,
    personal_allowed: true,
    models: [],
    ...over,
  } as ProviderRegistryEntry;
}

const REGISTRY = [
  provider({
    providerId: "anthropic",
    displayName: "Anthropic",
    models: [{ id: "claude-a" }, { id: "claude-b" }] as ProviderRegistryEntry["models"],
  }),
  provider({
    providerId: "claude-code",
    displayName: "Claude Code",
    authMode: "oauth2",
    models: [{ id: "claude-a" }] as ProviderRegistryEntry["models"],
  }),
  provider({
    providerId: "mistral",
    displayName: "Mistral",
    apiShape: "mistral-conversations",
    defaultBaseUrl: "https://api.mistral.ai",
    models: [{ id: "mistral-medium" }] as ProviderRegistryEntry["models"],
  }),
];

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
    created_by: null,
    allowed_actions: [],
    bindable: true,
    needs_reconnection: false,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...over,
  };
}

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

const ORG_KEY = credential({});
const EMPTY_KEY = credential({ id: "cred_empty", label: "Mistral", providerId: "mistral" });
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
  label: "Abonnement",
  providerId: "claude-code",
  authMode: "oauth2",
  owner_type: "user",
  owner_id: "usr_bob",
  owner_name: "Bob",
  bindable: false,
});
const BUILT_IN = credential({ id: "cred_builtin", source: "built-in", providerId: null });

const BOUND = model({});
const MEMBER_A = model({
  id: "mdl_m",
  label: "Claude A (perso)",
  credentialId: null,
  binding: "member",
});
const MEMBER_MISTRAL = model({
  id: "mdl_mm",
  label: "Mistral M",
  providerId: "mistral",
  modelId: "mistral-medium",
  credentialId: null,
  binding: "member",
});
const SYSTEM = model({
  id: "mdl_s",
  label: "Système",
  source: "built-in",
  credentialId: "cred_builtin",
});

describe("providerRows", () => {
  const rows = providerRows(
    [BOUND, MEMBER_A, MEMBER_MISTRAL, SYSTEM],
    [BUILT_IN, ORG_KEY, EMPTY_KEY, BOB_SUBSCRIPTION, MY_KEY],
    REGISTRY,
    "usr_me",
  );
  const row = (id: string) => rows.find((r) => r.id === id)!;

  it("serves an organization key's models from the models bound to it", () => {
    expect(row("cred_org").models.map((m) => m.id)).toEqual(["mdl_1"]);
    expect(row("cred_org").kind).toBe("org-key");
    expect(row("cred_empty").models).toEqual([]);
  });

  it("serves a personal key the unbound models of its own service", () => {
    expect(row("cred_me").kind).toBe("personal-key");
    expect(row("cred_me").models.map((m) => m.id)).toEqual(["mdl_m"]);
  });

  it("serves a subscription the unbound models its plan offers on the same API", () => {
    expect(row("cred_bob").kind).toBe("subscription");
    expect(row("cred_bob").models.map((m) => m.id)).toEqual(["mdl_m"]);
  });

  it("makes the instance's models one row of its own, and no row of the built-in credential", () => {
    expect(row("instance").kind).toBe("system");
    expect(row("instance").models.map((m) => m.id)).toEqual(["mdl_s"]);
    expect(rows.some((r) => r.id === "cred_builtin")).toBe(false);
  });

  it("orders the organization first, the caller's own before the others', the instance last", () => {
    expect(rows.map((r) => r.id)).toEqual([
      "cred_org",
      "cred_empty",
      "cred_me",
      "cred_bob",
      "instance",
    ]);
  });

  it("keeps a key the caller cannot read, named by its service, with its models", () => {
    const unseen = providerRows([BOUND], [], REGISTRY, "usr_me");
    expect(unseen).toHaveLength(1);
    expect(unseen[0]).toMatchObject({ id: "cred_org", credential: null, label: "Anthropic" });
  });

  it("lists only the models that are switched on, and says when every one is off", () => {
    const off = providerRows([model({ enabled: false })], [ORG_KEY], REGISTRY, "usr_me");
    expect(off[0]!.models).toEqual([]);
    expect(off[0]!.disabled).toBe(true);
    expect(row("cred_org").disabled).toBe(false);
    // A key with no model at all is not « disabled »: there is nothing to switch back on.
    expect(row("cred_empty").disabled).toBe(false);
  });
});

describe("personalServiceRows", () => {
  const models = [
    BOUND,
    MEMBER_A,
    model({
      id: "mdl_off",
      providerId: "mistral",
      modelId: "mistral-medium",
      credentialId: null,
      binding: "member",
      enabled: false,
    }),
  ];
  const rows = personalServiceRows(models, [ORG_KEY, BOB_SUBSCRIPTION, MY_KEY], REGISTRY, "usr_me");
  const row = (id: string) => rows.find((r) => r.id === id)!;

  it("makes a row of each service with a model left to personal keys", () => {
    expect(rows.map((r) => r.id)).toEqual(["anthropic", "mistral"]);
    expect(row("anthropic").models.map((m) => m.id)).toEqual(["mdl_m"]);
  });

  it("names who plugged a key in, a subscription under the service it serves, the caller first", () => {
    expect(row("anthropic").holders).toEqual([
      { id: "usr_me", name: "Moi", mine: true },
      { id: "usr_bob", name: "Bob", mine: false },
    ]);
    expect(row("mistral").holders).toEqual([]);
  });

  it("says when every model of a service is switched off", () => {
    expect(row("mistral")).toMatchObject({ models: [], disabled: true });
    expect(row("anthropic").disabled).toBe(false);
  });

  it("keeps a service a key was connected for, though no model is left to it", () => {
    const [only] = personalServiceRows([], [MY_KEY], REGISTRY, "usr_me");
    expect(only).toMatchObject({ id: "anthropic", models: [], disabled: false });
  });

  it("leaves out a service nothing is open for, and the organization's own keys", () => {
    expect(personalServiceRows([BOUND], [ORG_KEY], REGISTRY, "usr_me")).toEqual([]);
  });

  it("flags a service whose every key needs reconnecting", () => {
    const dead = { ...MY_KEY, needs_reconnection: true };
    expect(personalServiceRows([MEMBER_A], [dead], REGISTRY, "usr_me")[0]!.unavailable).toBe(true);
    expect(
      personalServiceRows([MEMBER_A], [dead, BOB_SUBSCRIPTION], REGISTRY, "usr_me")[0]!.unavailable,
    ).toBe(false);
  });
});

describe("rowStates", () => {
  const base = { models: [BOUND], unavailable: false, disabled: false };

  it("says nothing when all is well and the row does not carry the default", () => {
    expect(rowStates(base)).toEqual([]);
  });

  it("gathers what is worth saying, in reading order", () => {
    expect(
      rowStates({ ...base, models: [model({ is_default: true })], unavailable: true }),
    ).toEqual(["unavailable", "default"]);
    expect(rowStates({ ...base, models: [], disabled: true })).toEqual(["disabled"]);
    expect(rowStates({ ...base, noKey: true })).toEqual(["no-key"]);
  });
});

describe("providersOpenToPersonalKeys", () => {
  it("offers only the providers whose key would serve a model opened to personal keys", () => {
    // Claude A is opened: Anthropic's key and the Claude Code subscription both serve it.
    const open = providersOpenToPersonalKeys([BOUND, MEMBER_A], REGISTRY);
    expect([...open].sort()).toEqual(["anthropic", "claude-code"]);
  });

  it("offers nothing while the organization opened no model to personal keys", () => {
    expect(providersOpenToPersonalKeys([BOUND, SYSTEM], REGISTRY).size).toBe(0);
  });

  it("leaves out a provider whose opened models are all disabled", () => {
    const open = providersOpenToPersonalKeys([{ ...MEMBER_MISTRAL, enabled: false }], REGISTRY);
    expect(open.has("mistral")).toBe(false);
  });
});
