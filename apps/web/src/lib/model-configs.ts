// SPDX-License-Identifier: Apache-2.0

/**
 * Model configurations and their connections, read off the wire (pure).
 *
 * A **configuration** is a provider family the organization set up (its label, a gateway's
 * endpoint, its models, whether members may bring their own connection). A **connection** is a
 * secret under it (an API key or a subscription): the organization's (`owner_type: org`) or a
 * member's own. The models belong to the configuration; its connections serve them.
 *
 * Every request body the models pages send is built here, so a test pins its payload.
 */

import type { components, paths } from "../api/client";
import { ApiError } from "../api/errors";
import {
  groupModelsForPicker,
  preferSubscription,
  type PickerGroup,
} from "@appstrate/ui/components/model-picker-groups";
import type {
  ModelProviderCredentialInfo,
  ProviderRegistryEntry,
} from "../hooks/use-model-provider-credentials";
import type { OrgModelInfo } from "../hooks/use-models";

export type ModelConfigInfo = components["schemas"]["ModelConfig"];

/** A built-in model or a managed alias: the instance's, outside every configuration. */
export function isSystemModel(m: Pick<OrgModelInfo, "source" | "aliased">): boolean {
  return m.source === "built-in" || m.aliased;
}

/** The models of a configuration, switched-off ones included (the dialog lists them unticked). */
export function modelsOfConfig(models: readonly OrgModelInfo[], configId: string): OrgModelInfo[] {
  return models.filter((m) => m.config_id === configId && !isSystemModel(m));
}

/** The instance's own models: its last row. */
export function systemModels(models: readonly OrgModelInfo[]): OrgModelInfo[] {
  return models.filter(isSystemModel);
}

/**
 * What a configuration's row says of it: `active` (a live organization connection, or members'
 * own when only they serve it), `connect` (nothing serves it yet), `reconnect` (its
 * organization connections are all dead).
 */
export type ConfigState = "active" | "connect" | "reconnect";

export function configState(
  config: Pick<
    ModelConfigInfo,
    "org_connection" | "personal_connections_allowed" | "personal_connection_count"
  >,
): ConfigState {
  if (config.org_connection === "active") return "active";
  if (config.org_connection === "needs_reconnection") return "reconnect";
  return config.personal_connections_allowed && (config.personal_connection_count ?? 0) > 0
    ? "active"
    : "connect";
}

/** A configuration's connections the caller can read, the organization's apart from members'. */
export function connectionsOfConfig(
  credentials: readonly ModelProviderCredentialInfo[],
  configId: string,
): { org: ModelProviderCredentialInfo[]; personal: ModelProviderCredentialInfo[] } {
  const mine = credentials.filter((c) => c.config_id === configId);
  return {
    org: mine.filter((c) => c.owner_type === "org"),
    personal: mine.filter((c) => c.owner_type === "user"),
  };
}

/**
 * What a collapsed row says of the organization's connections: none, their number when the caller
 * reads them (`orgCount`, `null` without `model-provider-credentials:read`), else the state alone.
 */
export type OrgConnectionSummary =
  | { key: "modelConfigs.summary.noOrgConnection" }
  | { key: "modelConfigs.summary.orgConnection" }
  | { key: "modelConfigs.summary.orgConnections"; count: number };

export function orgConnectionSummary(
  orgConnection: ModelConfigInfo["org_connection"],
  orgCount: number | null,
): OrgConnectionSummary {
  if (orgConnection === "none") return { key: "modelConfigs.summary.noOrgConnection" };
  if (orgCount === null || orgCount === 0) return { key: "modelConfigs.summary.orgConnection" };
  return { key: "modelConfigs.summary.orgConnections", count: orgCount };
}

/**
 * The organization connects only subscriptions: the LLM proxy (remote runs, API keys) never
 * serves through one.
 */
export function onlySubscriptions(org: readonly Pick<ModelProviderCredentialInfo, "authMode">[]) {
  return org.length > 0 && org.every((c) => c.authMode === "oauth2");
}

/**
 * The organization connections a row's « Reconnecter » repairs: the dead ones the caller may act
 * on (a subscription re-paired, an API key replaced), as the server's `allowed_actions` say.
 */
export function repairableConnections<
  T extends Pick<
    ModelProviderCredentialInfo,
    "authMode" | "needs_reconnection" | "allowed_actions"
  >,
>(org: readonly T[]): T[] {
  return org.filter(
    (c) =>
      c.needs_reconnection &&
      c.allowed_actions.includes(c.authMode === "oauth2" ? "reconnect" : "edit"),
  );
}

/**
 * What Preferences › Models lists: the configurations that accept personal connections, and any
 * where the caller still holds one (the organization may have switched them off since: the
 * connection stays, serves nothing, and its owner may delete it).
 */
export function preferencesConfigs<
  C extends Pick<ModelConfigInfo, "id" | "personal_connections_allowed">,
>(configs: readonly C[], own: readonly Pick<ModelProviderCredentialInfo, "config_id">[]): C[] {
  return configs.filter(
    (c) => c.personal_connections_allowed || own.some((o) => o.config_id === c.id),
  );
}

/** A way to connect a configuration: who owns the connection, and which kind of secret. */
export interface ConnectChoice {
  owner: "org" | "user";
  provider: ProviderRegistryEntry;
}

/**
 * The connect menu of a configuration: for the organization (`model-provider-credentials:write`),
 * then with the caller's own secret (`:connect`, where the configuration allows it and the caller
 * has none yet in it: `own`, their own connections; a replacement is the connection's own menu);
 * each by the kinds of secret the configuration accepts (API keys first, as the server lists them).
 */
export function connectChoices(
  config: Pick<ModelConfigInfo, "id" | "accepts" | "personal_connections_allowed">,
  registry: readonly ProviderRegistryEntry[],
  can: { org: boolean; personal: boolean },
  own: readonly Pick<ModelProviderCredentialInfo, "config_id">[],
): ConnectChoice[] {
  const providers = config.accepts.flatMap((accepted) => {
    const provider = registry.find((p) => p.providerId === accepted.provider_id);
    return provider ? [provider] : [];
  });
  const owners: ConnectChoice["owner"][] = [
    ...(can.org ? (["org"] as const) : []),
    ...(can.personal &&
    config.personal_connections_allowed &&
    !own.some((c) => c.config_id === config.id)
      ? (["user"] as const)
      : []),
  ];
  return owners.flatMap((owner) => providers.map((provider) => ({ owner, provider })));
}

/** The configuration already standing for a catalog provider (a gateway may have several). */
export function existingConfigFor(
  configs: readonly ModelConfigInfo[],
  provider: Pick<ProviderRegistryEntry, "providerId" | "baseUrlOverridable">,
): ModelConfigInfo | undefined {
  if (provider.baseUrlOverridable) return undefined;
  return configs.find(
    (c) =>
      c.provider_id === provider.providerId ||
      c.accepts.some((a) => a.provider_id === provider.providerId),
  );
}

/** The configuration a `409 model_config_exists` points at (`existing_config_id`), else `null`. */
export function existingConfigIdOf(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.code !== "model_config_exists") return null;
  const id = err.details?.existing_config_id;
  return typeof id === "string" ? id : null;
}

type CreateConfigBody =
  paths["/api/model-configs"]["post"]["requestBody"]["content"]["application/json"];

/** `POST /api/model-configs`: the endpoint only for a gateway, the label only when typed. */
export function createConfigBody(input: {
  provider: Pick<ProviderRegistryEntry, "providerId" | "baseUrlOverridable">;
  label: string;
  baseUrl: string;
  personalConnectionsAllowed: boolean;
}): CreateConfigBody {
  const label = input.label.trim();
  return {
    provider_id: input.provider.providerId,
    ...(label ? { label } : {}),
    ...(input.provider.baseUrlOverridable ? { base_url: input.baseUrl.trim() } : {}),
    personal_connections_allowed: input.personalConnectionsAllowed,
  };
}

type CreateConnectionBody =
  paths["/api/model-provider-credentials"]["post"]["requestBody"]["content"]["application/json"];

/** `POST /api/model-provider-credentials`: an API key joining a configuration, owned as asked. */
export function connectionBody(input: {
  providerId: string;
  configId: string;
  apiKey: string;
  ownerType: "org" | "user";
}): CreateConnectionBody {
  return {
    providerId: input.providerId,
    api_key: input.apiKey.trim(),
    config_id: input.configId,
    owner_type: input.ownerType,
  };
}

type UpdateConnectionBody =
  paths["/api/model-provider-credentials/{id}"]["patch"]["requestBody"]["content"]["application/json"];

/** `PATCH /api/model-provider-credentials/{id}` of « Changer la clé »: the new key alone. */
export function keyUpdateBody(apiKey: string): UpdateConnectionBody {
  return { api_key: apiKey.trim() };
}

/** `PATCH /api/model-provider-credentials/{id}` of a rename: the label alone. */
export function connectionLabelBody(label: string): UpdateConnectionBody {
  return { label: label.trim() };
}

type TestConnectionBody = Omit<
  paths["/api/model-provider-credentials/test"]["post"]["requestBody"]["content"]["application/json"],
  "base_url"
> & { base_url?: string; config_id?: string };

/**
 * `POST /api/model-provider-credentials/test`: the key typed (or the stored one of `credentialId`,
 * when none is typed), tried against the configuration the form is attached to: the server reads
 * the endpoint off it, so a caller who may not name a free `base_url` can still test a gateway.
 */
export function connectionTestBody(input: {
  providerId: string;
  /** The configuration the form is attached to; a stored connection carries its own. */
  configId: string | null;
  apiKey: string;
  credentialId: string | null;
}): TestConnectionBody {
  const apiKey = input.apiKey.trim();
  return {
    providerId: input.providerId,
    ...(input.configId ? { config_id: input.configId } : {}),
    ...(apiKey ? { api_key: apiKey } : {}),
    ...(input.credentialId ? { credentialId: input.credentialId } : {}),
  };
}

type SeedBody = paths["/api/models/seed"]["post"]["requestBody"]["content"]["application/json"];

/** `POST /api/models/seed`: the onboarding's featured models, into the configuration. */
export function seedModelsBody(configId: string, modelIds: readonly string[]): SeedBody {
  return { config_id: configId, model_ids: [...modelIds] };
}

/**
 * The organization default's choices, in the order of the other pickers (the organization's
 * configurations, the instance's own last). The default also serves schedules, API keys and end
 * users, which only an organization connection can pay for, as the server's
 * `assertOrgServesDefault` checks per model: so the list is `groupModelsForPicker` with no human
 * payer (`scheduled`), where a model counts as served only when a live organization connection
 * serves it (`serves_model_ids`). `credentials` is `undefined` when the caller cannot read the connections: the configuration's own `org_connection` then decides, for every model of it. The others stay, greyed with their reason. A switched-off model
 * is listed only when it is the current default.
 */
export function defaultModelGroups(
  models: readonly OrgModelInfo[],
  configs: readonly ModelConfigInfo[],
  credentials: readonly ModelProviderCredentialInfo[] | undefined,
): PickerGroup[] {
  const served = new Set(
    (credentials ?? [])
      .filter((c) => c.owner_type === "org" && !c.needs_reconnection)
      .flatMap((c) => c.serves_model_ids),
  );
  const activeConfigs = new Set(
    configs.filter((c) => c.org_connection === "active").map((c) => c.id),
  );
  const candidates = models
    .filter((m) => m.enabled || m.is_default)
    .map((m) => {
      const orgServes =
        credentials === undefined
          ? m.config_id !== null && activeConfigs.has(m.config_id)
          : served.has(m.id);
      return {
        ...m,
        billed_to: isSystemModel(m) ? ("system" as const) : orgServes ? ("org" as const) : null,
      };
    });
  return groupModelsForPicker(candidates, { configs, scheduled: true });
}

type UpdateConfigBody =
  paths["/api/model-configs/{id}"]["patch"]["requestBody"]["content"]["application/json"];

/** `PATCH /api/model-configs/{id}`: one field at a time (the endpoint, the label, members' switch). */
export function configUpdateBody(
  change: { baseUrl: string } | { label: string } | { personalConnectionsAllowed: boolean },
): UpdateConfigBody {
  if ("baseUrl" in change) return { base_url: change.baseUrl.trim() };
  if ("label" in change) return { label: change.label.trim() };
  return { personal_connections_allowed: change.personalConnectionsAllowed };
}

/**
 * Who serves the caller's calls to a configuration's models, as Preferences › Models says it:
 * their own connection first (the server prefers it, a subscription before a key), else the organization's, else nobody.
 */
export type PersonalServing =
  | { by: "mine"; connection: ModelProviderCredentialInfo; state: ConfigState }
  | { by: "org"; state: ConfigState }
  | { by: "none"; state: ConfigState };

export function personalServing(
  config: Pick<ModelConfigInfo, "id" | "org_connection">,
  own: readonly ModelProviderCredentialInfo[],
): PersonalServing {
  const mine = own.filter((c) => c.config_id === config.id);
  const live = preferSubscription(
    mine.filter((c) => !c.needs_reconnection),
    (c) => c.authMode === "oauth2",
  );
  if (live) return { by: "mine", connection: live, state: "active" };
  if (mine[0]) return { by: "mine", connection: mine[0], state: "reconnect" };
  if (config.org_connection === "active") return { by: "org", state: "active" };
  return { by: "none", state: "connect" };
}
