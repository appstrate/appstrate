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
import type { PickerGroup } from "@appstrate/ui/components/model-picker-groups";
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
 * The organization connects only subscriptions: the LLM proxy (remote runs, API keys) never
 * serves through one.
 */
export function onlySubscriptions(org: readonly Pick<ModelProviderCredentialInfo, "authMode">[]) {
  return org.length > 0 && org.every((c) => c.authMode === "oauth2");
}

/** A way to connect a configuration: who owns the connection, and which kind of secret. */
export interface ConnectChoice {
  owner: "org" | "user";
  provider: ProviderRegistryEntry;
}

/**
 * The connect menu of a configuration: for the organization (`model-provider-credentials:write`),
 * then with the caller's own secret (`:connect`, where the configuration allows it); each by
 * the kinds of secret the configuration accepts (API keys first, as the server lists them).
 */
export function connectChoices(
  config: Pick<ModelConfigInfo, "accepts" | "personal_connections_allowed">,
  registry: readonly ProviderRegistryEntry[],
  can: { org: boolean; personal: boolean },
): ConnectChoice[] {
  const providers = config.accepts.flatMap((accepted) => {
    const provider = registry.find((p) => p.providerId === accepted.provider_id);
    return provider ? [provider] : [];
  });
  const owners: ConnectChoice["owner"][] = [
    ...(can.org ? (["org"] as const) : []),
    ...(can.personal && config.personal_connections_allowed ? (["user"] as const) : []),
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

type SeedBody = paths["/api/models/seed"]["post"]["requestBody"]["content"]["application/json"];

/** `POST /api/models/seed`: the onboarding's featured models, into the configuration. */
export function seedModelsBody(configId: string, modelIds: readonly string[]): SeedBody {
  return { config_id: configId, model_ids: [...modelIds] };
}

/** Why a model cannot become the organization default, `null` when it can. */
function defaultBlock(
  model: OrgModelInfo,
  config: ModelConfigInfo | undefined,
): PickerGroup["entries"][number]["blocked"] {
  if (isSystemModel(model)) return null;
  if (!model.enabled) return "disabled";
  if (!config || config.org_connection === "none") return "orgConnectionMissing";
  if (config.org_connection === "needs_reconnection" || model.needs_reconnection) {
    return "orgUnavailable";
  }
  return null;
}

/**
 * The organization default's choices, grouped by configuration (the instance's own last): the
 * default also serves schedules, API keys and end users, so only a model an organization
 * connection serves is eligible; the others stay, greyed with their reason.
 */
export function defaultModelGroups(
  models: readonly OrgModelInfo[],
  configs: readonly ModelConfigInfo[],
): PickerGroup[] {
  const groups: PickerGroup[] = configs.flatMap((config) => {
    const entries = modelsOfConfig(models, config.id)
      .filter((m) => m.enabled || m.is_default)
      .map((model) => ({
        model,
        isDefault: model.is_default,
        blocked: defaultBlock(model, config),
      }));
    return entries.length > 0
      ? [
          {
            key: config.id,
            kind: "config" as const,
            name: config.label,
            subscription: false,
            needs: null,
            entries,
          },
        ]
      : [];
  });
  const system = systemModels(models).filter((m) => m.enabled || m.is_default);
  if (system.length > 0) {
    groups.push({
      key: "system",
      kind: "system",
      name: null,
      subscription: false,
      needs: null,
      entries: system.map((model) => ({
        model,
        isDefault: model.is_default,
        blocked: model.enabled ? null : "disabled",
      })),
    });
  }
  return groups;
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
 * their own connection first (the server prefers it), else the organization's, else nobody.
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
  const live = mine.find((c) => !c.needs_reconnection);
  if (live) return { by: "mine", connection: live, state: "active" };
  if (mine[0]) return { by: "mine", connection: mine[0], state: "reconnect" };
  if (config.org_connection === "active") return { by: "org", state: "active" };
  return { by: "none", state: "connect" };
}
