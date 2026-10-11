// SPDX-License-Identifier: Apache-2.0

/**
 * The rows of the providers table (Settings › Models, Preferences › My providers).
 *
 * One rule reads the whole page: a connected provider makes its models available. A row is
 * a provider, and its models are the ones it makes usable:
 *
 * - an **organization key** serves the models bound to it (`credentialId`);
 * - a **personal key** or **personal subscription** serves the models left unbound
 *   (`binding: "member"`) that its holder can use with it;
 * - the **instance** serves the models it ships (built-in, or managed aliases).
 *
 * A key the caller cannot read (a role with `models:read` alone gets no credential row) still
 * shows, named by the service its models run on, with nothing to act on.
 */

import type {
  ModelProviderCredentialInfo,
  ProviderRegistryEntry,
} from "../hooks/use-model-provider-credentials";
import type { OrgModelInfo } from "../hooks/use-models";
import { modelSource } from "./model-source";
import { getProviderById, resolveProviderEntry } from "./provider-registry-helpers";

export type ProviderKind = "org-key" | "personal-key" | "subscription" | "system";

export interface ProviderRow {
  /** The credential's id; `INSTANCE_ROW_ID` for the instance's row. */
  id: string;
  kind: ProviderKind;
  /** `null` for the instance, and for an organization key the caller cannot read. */
  credential: ModelProviderCredentialInfo | null;
  label: string;
  /** The services the row's models run on (the filter reads these). */
  serviceIds: string[];
  /** The service a key belongs to; `null` for the instance, which spans several. */
  serviceName: string | null;
  /** `org`, `instance` or `user:<id>`. */
  owner: string;
  ownerName: string | null;
  /** The models this provider makes usable, switched-on ones only. */
  models: OrgModelInfo[];
  /** The key can no longer serve (a dead subscription, a secret that no longer decrypts). */
  unavailable: boolean;
}

const INSTANCE_ROW_ID = "instance";

/** A model the instance ships: a built-in one, or a managed alias whose binding is hidden. */
export function isSystemModel(m: OrgModelInfo): boolean {
  return m.source === "built-in" || m.binding === "managed";
}

/** The models an organization leaves to each person's own key or subscription. */
export function memberModels(models: readonly OrgModelInfo[]): OrgModelInfo[] {
  return models.filter((m) => m.binding === "member" && !isSystemModel(m));
}

/**
 * Whether a personal credential of `credentialProvider` serves the unbound model `m`: the same
 * service, or a subscription whose plan offers that model on the same API (Claude Code serves
 * Anthropic's models). The server's `servesModel` is the authority; this reads the registry.
 */
function serves(
  credentialProvider: ProviderRegistryEntry,
  m: OrgModelInfo,
  registry: readonly ProviderRegistryEntry[],
): boolean {
  if (m.providerId === credentialProvider.providerId) return true;
  if (credentialProvider.authMode !== "oauth2" || !m.providerId) return false;
  const modelProvider = getProviderById(m.providerId, registry);
  return (
    !!modelProvider &&
    modelProvider.apiShape === credentialProvider.apiShape &&
    modelProvider.defaultBaseUrl === credentialProvider.defaultBaseUrl &&
    credentialProvider.models.some((offered) => offered.id === m.modelId)
  );
}

function kindOf(pk: ModelProviderCredentialInfo): ProviderKind {
  if (pk.owner_type === "org") return "org-key";
  return pk.authMode === "oauth2" ? "subscription" : "personal-key";
}

function distinct(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

const ORDER: Record<ProviderKind, number> = {
  "org-key": 0,
  "personal-key": 1,
  subscription: 1,
  system: 2,
};

/** Organization first, then people (the caller's own before the others'), the instance last. */
export function providerRows(
  models: readonly OrgModelInfo[],
  credentials: readonly ModelProviderCredentialInfo[],
  registry: readonly ProviderRegistryEntry[],
  userId: string | undefined,
): ProviderRow[] {
  const usable = models.filter((m) => m.enabled);
  const system = usable.filter(isSystemModel);
  const unbound = memberModels(usable);
  const rows: ProviderRow[] = [];

  for (const pk of credentials) {
    // The credential behind the instance's models: its models are the instance's row.
    if (pk.source === "built-in") continue;
    const provider = resolveProviderEntry(pk, registry);
    const kind = kindOf(pk);
    rows.push({
      id: pk.id,
      kind,
      credential: pk,
      label: pk.label,
      serviceIds: provider ? [provider.providerId] : [],
      serviceName: provider?.displayName ?? null,
      owner: kind === "org-key" ? "org" : `user:${pk.owner_id}`,
      ownerName: pk.owner_name,
      models:
        kind === "org-key"
          ? usable.filter((m) => m.credentialId === pk.id && !isSystemModel(m))
          : provider
            ? unbound.filter((m) => serves(provider, m, registry))
            : [],
      unavailable: pk.needs_reconnection === true,
    });
  }

  // Organization keys the caller cannot read, known only through the models bound to them.
  const known = new Set(credentials.map((pk) => pk.id));
  const unseen = new Map<string, OrgModelInfo[]>();
  for (const m of usable) {
    if (m.credentialId === null || known.has(m.credentialId) || isSystemModel(m)) continue;
    unseen.set(m.credentialId, [...(unseen.get(m.credentialId) ?? []), m]);
  }
  for (const [credentialId, bound] of unseen) {
    rows.push({
      id: credentialId,
      kind: "org-key",
      credential: null,
      label: bound[0]?.provider_name ?? "",
      serviceIds: distinct(bound.map((m) => m.providerId)),
      serviceName: bound[0]?.provider_name ?? null,
      owner: "org",
      ownerName: null,
      models: bound,
      unavailable: bound.some((m) => m.needs_reconnection),
    });
  }

  if (system.length > 0) {
    rows.push({
      id: INSTANCE_ROW_ID,
      kind: "system",
      credential: null,
      label: "",
      serviceIds: distinct(system.map((m) => m.providerId)),
      serviceName: null,
      owner: "instance",
      ownerName: null,
      models: system,
      unavailable: false,
    });
  }

  const own = (row: ProviderRow) => (row.owner === `user:${userId}` ? 0 : 1);
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        ORDER[a.row.kind] - ORDER[b.row.kind] ||
        (a.row.kind === "org-key" || a.row.kind === "system" ? 0 : own(a.row) - own(b.row)) ||
        a.index - b.index,
    )
    .map(({ row }) => row);
}

/**
 * The services a person may serve with a key of their own: those with a fixed endpoint that
 * list their models without a key to ask with. The organization's open-to-personal-keys
 * summary names these, and « Modifier » edits their models.
 */
export function personalModelServices(
  registry: readonly ProviderRegistryEntry[],
): ProviderRegistryEntry[] {
  return registry.filter(
    (p) =>
      p.authMode === "api_key" &&
      p.personal_allowed &&
      !p.baseUrlOverridable &&
      modelSource(p) !== "discover",
  );
}

export interface ServiceSummary {
  service: ProviderRegistryEntry;
  models: OrgModelInfo[];
}

/**
 * Per service, the models usable with a personal key: the services the organization already
 * has something for (a key, or a model left to personal keys), each with its models or none.
 */
export function personalModelSummary(
  models: readonly OrgModelInfo[],
  rows: readonly ProviderRow[],
  registry: readonly ProviderRegistryEntry[],
): ServiceSummary[] {
  const unbound = memberModels(models);
  const known = new Set([
    ...unbound.map((m) => m.providerId),
    ...rows.filter((r) => r.kind !== "system").flatMap((r) => r.serviceIds),
  ]);
  return personalModelServices(registry)
    .filter((service) => known.has(service.providerId))
    .map((service) => ({
      service,
      models: unbound.filter((m) => m.providerId === service.providerId),
    }));
}

export interface ProviderFilters {
  types: string[];
  services: string[];
  owners: string[];
}

/** Dimensions narrow each other, values of one are alternatives (the toolbar's rule). */
export function filterProviderRows(
  rows: readonly ProviderRow[],
  filters: ProviderFilters,
): ProviderRow[] {
  return rows.filter(
    (row) =>
      (filters.types.length === 0 || filters.types.includes(row.kind)) &&
      (filters.services.length === 0 ||
        row.serviceIds.some((id) => filters.services.includes(id))) &&
      (filters.owners.length === 0 || filters.owners.includes(row.owner)),
  );
}
