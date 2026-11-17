// SPDX-License-Identifier: Apache-2.0

/**
 * The rows of the providers table: a connected provider makes its models available.
 * An **organization key** serves the models bound to it (`credentialId`); a **personal
 * key/subscription** serves the models left unbound (`binding: "user"`) its holder can
 * use; the **instance** serves the models it ships. A key the caller cannot read
 * (`models:read` alone) still shows, named by its service, with nothing to act on.
 */

import type {
  ModelProviderCredentialInfo,
  ProviderRegistryEntry,
} from "../hooks/use-model-provider-credentials";
import type { OrgModelInfo } from "../hooks/use-models";
import { modelSource } from "./model-source";
import { resolveProviderEntry } from "./provider-registry-helpers";

export type ProviderKind = "org-key" | "personal-key" | "subscription" | "system";

export interface ProviderRow {
  /** The credential's id; `INSTANCE_ROW_ID` for the instance's row. */
  id: string;
  kind: ProviderKind;
  /** `null` for the instance, and for an organization key the caller cannot read. */
  credential: ModelProviderCredentialInfo | null;
  label: string;
  serviceIds: string[];
  /** `null` for the instance, which spans several services. */
  serviceName: string | null;
  /** `org`, `instance` or `user:<id>`. */
  owner: string;
  ownerName: string | null;
  /** Switched-on models only; the instance's row keeps switched-off ones, which the server still resolves as the default. */
  models: OrgModelInfo[];
  /** The key can no longer serve (dead subscription, undecryptable secret). */
  unavailable: boolean;
  /** It carries models, all switched off. */
  disabled: boolean;
}

const INSTANCE_ROW_ID = "instance";

export function isSystemModel(m: OrgModelInfo): boolean {
  return m.source === "built-in" || m.binding === "managed";
}

export function memberModels(models: readonly OrgModelInfo[]): OrgModelInfo[] {
  return models.filter((m) => m.binding === "user" && !isSystemModel(m));
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
  const system = models.filter(isSystemModel);
  const unbound = memberModels(models);
  const rows: ProviderRow[] = [];

  for (const pk of credentials) {
    // The credential behind the instance's models: its models are the instance's row.
    if (pk.source === "built-in") continue;
    const provider = resolveProviderEntry(pk, registry);
    const kind = kindOf(pk);
    const bound =
      kind === "org-key"
        ? models.filter((m) => m.credentialId === pk.id && !isSystemModel(m))
        : unbound.filter((m) => pk.serves_model_ids.includes(m.id));
    const served = bound.filter((m) => m.enabled);
    rows.push({
      id: pk.id,
      kind,
      credential: pk,
      label: pk.label,
      serviceIds: provider ? [provider.providerId] : [],
      serviceName: provider?.displayName ?? null,
      owner: kind === "org-key" ? "org" : `user:${pk.owner_id}`,
      ownerName: pk.owner_name,
      models: served,
      unavailable: pk.needs_reconnection === true,
      disabled: bound.length > 0 && served.length === 0,
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
      disabled: false,
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
      disabled: system.every((m) => !m.enabled),
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
 * Whether the organization may leave a service's models to each person's own key
 * (`binding: "user"`): the service is open to personal keys, and its listing needs no
 * key to ask with (a model left to everyone has none).
 */
export function allowsMemberModels(p: ProviderRegistryEntry): boolean {
  return p.personal_allowed && modelSource(p) !== "discover";
}

export function personalModelServices(
  registry: readonly ProviderRegistryEntry[],
): ProviderRegistryEntry[] {
  return registry.filter(allowsMemberModels);
}

/** A person who connected a personal key or subscription for a service. */
export interface ServiceHolder {
  id: string;
  name: string | null;
  /** The caller: the cell says « vous ». */
  mine: boolean;
}

/** A service open to personal keys: the models left to them, and who plugged a key in. */
export interface PersonalServiceRow {
  /** The service's provider id. */
  id: string;
  service: ProviderRegistryEntry;
  models: OrgModelInfo[];
  /** Everyone the server shows the caller, the caller first. */
  holders: ServiceHolder[];
  /** Keys are connected and none can serve. */
  unavailable: boolean;
  /** Models are left to personal keys, all switched off. */
  disabled: boolean;
}

/**
 * One row per service open to personal keys: those with a model left to them or a key
 * already connected. A subscription belongs to the service whose models its plan offers
 * (Claude Code to Anthropic).
 */
export function personalServiceRows(
  models: readonly OrgModelInfo[],
  credentials: readonly ModelProviderCredentialInfo[],
  registry: readonly ProviderRegistryEntry[],
  userId: string | undefined,
): PersonalServiceRow[] {
  const members = memberModels(models);
  const personal = credentials.filter((pk) => pk.owner_type === "user");
  return personalModelServices(registry).flatMap((service) => {
    const left = members.filter((m) => m.providerId === service.providerId);
    const served = left.filter((m) => m.enabled);
    const keys = personal.filter((pk) => {
      const provider = resolveProviderEntry(pk, registry);
      return (
        !!provider &&
        (provider.providerId === service.providerId ||
          served.some((m) => pk.serves_model_ids.includes(m.id)))
      );
    });
    if (left.length === 0 && keys.length === 0) return [];
    const holders = new Map<string, ServiceHolder>();
    for (const pk of keys) {
      const id = pk.owner_id ?? pk.id;
      holders.set(id, { id, name: pk.owner_name, mine: id === userId });
    }
    return {
      id: service.providerId,
      service,
      models: served,
      holders: [...holders.values()].sort((a, b) => Number(b.mine) - Number(a.mine)),
      unavailable: keys.length > 0 && keys.every((pk) => pk.needs_reconnection === true),
      disabled: left.length > 0 && served.length === 0,
    };
  });
}

/** What the State column says about a row, in the order it is read. Nothing when all is well. */
export type RowState = "unavailable" | "default" | "disabled" | "no-key";

export function rowStates(row: {
  models: readonly OrgModelInfo[];
  unavailable: boolean;
  disabled: boolean;
  /** Personal services: nobody connected a key. */
  noKey?: boolean;
}): RowState[] {
  const states: RowState[] = [];
  if (row.unavailable) states.push("unavailable");
  if (row.models.some((m) => m.is_default)) states.push("default");
  if (row.disabled) states.push("disabled");
  if (row.noKey) states.push("no-key");
  return states;
}
