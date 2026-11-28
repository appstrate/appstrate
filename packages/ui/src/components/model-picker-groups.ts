// SPDX-License-Identifier: Apache-2.0

/**
 * What a PERSON can pick in a model list, grouped by who pays for the call.
 *
 * Pure: no React, no I/O. The dashboard's pickers (an agent's Modèle section, a schedule's
 * Exécution, a run with options) and the chat's composer all feed `GET /api/models` through
 * here, so the same model reads the same way everywhere.
 *
 * `GET /api/models` already says, FOR THE CALLER, who pays (`billed_to`): `system` (a built-in
 * model), `org` (an organization connection of its configuration), `user` (one of the caller's
 * own connections), or `null` (none serves it). The model's configuration (`config_id`) says
 * what would: an organization connection to add or reconnect, or — when it allows them — the
 * caller's own connection. The groups are that, plus the caller's own connections to NAME a
 * personal group (« Ma clé perso »); an organization group is named by its configuration.
 */

import type { ModelPayer } from "@appstrate/core/model-payer";

export type PickerPayer = ModelPayer | null;

/** The fields of an `OrgModel` the picker reads (structural: web and chat rows both fit). */
export interface PickerModel {
  id: string;
  label: string | null;
  /** Upstream model id; `null` for a managed alias. */
  modelId: string | null;
  providerId?: string | null;
  provider_name?: string | null;
  /** Its model configuration; `null` for a built-in model and a managed alias. */
  config_id?: string | null;
  billed_to?: PickerPayer;
  enabled?: boolean;
  needs_reconnection?: boolean;
  is_default?: boolean;
}

/** One of the caller's own connections: it names a personal group and tells a dead key from none. */
export interface PickerCredential {
  id: string;
  label: string;
  /** The configuration it serves. */
  configId: string | null;
  /** A subscription (« Abonnement perso »), as opposed to an API key. */
  subscription: boolean;
  /** Dead: its owner must reconnect it. */
  needsReconnection: boolean;
  /** The models (`GET /api/models` ids) it serves: its `serves_model_ids`. */
  modelIds: readonly string[];
}

/** The fields of a `ModelConfig` the picker reads. */
export interface PickerConfig {
  id: string;
  label: string;
  personal_connections_allowed: boolean;
  org_connection: "active" | "needs_reconnection" | "none";
}

export type PickerReasonKind =
  "disabled" | "orgUnavailable" | "orgConnectionMissing" | "personalRequired" | "personalReconnect";

export interface PickerEntry {
  model: PickerModel;
  isDefault: boolean;
  /** Why the model cannot be picked; `null` when it can. */
  blocked: PickerReasonKind | null;
}

export type PickerGroupKind = "org" | "personal" | "system";

export interface PickerGroup {
  key: string;
  kind: PickerGroupKind;
  /** The configuration's or the connection's name, or the service; `null` when unnamed. */
  name: string | null;
  /** A personal group served by a subscription (« Abonnement perso »). */
  subscription: boolean;
  /** Personal models the caller has no working connection for: what they can do about it. */
  needs: { service: string | null; fix: "add" | "reconnect" | null } | null;
  entries: PickerEntry[];
}

export interface PickerContext {
  /** The caller's own connections (never the organization's, never another member's). */
  credentials?: readonly PickerCredential[];
  /**
   * The organization's model configurations (`GET /api/model-configs`); `undefined` until known,
   * while which configuration would serve an unserved model is not: it carries no reason yet.
   */
  configs?: readonly PickerConfig[];
  /** The caller may add or reconnect a connection of their own (`model-provider-credentials:connect`). */
  canConnect?: boolean;
  /**
   * No human pays: only an organization connection serves the call. A schedule runs alone, and so
   * do the API keys and end users the organization's default model serves.
   */
  scheduled?: boolean;
}

const KIND_ORDER = { org: 0, personal: 1, system: 2 } as const;

/**
 * The connection that serves first among those that can: the server tries a subscription before
 * a key (its marginal cost is nil), then the oldest, which is list order. One helper for every
 * surface that says who serves.
 */
export function preferSubscription<T>(
  connections: readonly T[],
  isSubscription: (connection: T) => boolean,
): T | undefined {
  return connections.find(isSubscription) ?? connections[0];
}

function servingCredential(
  model: PickerModel,
  own: readonly PickerCredential[],
): PickerCredential | undefined {
  return preferSubscription(
    own.filter((credential) => credential.modelIds.includes(model.id)),
    (credential) => credential.subscription,
  );
}

interface Placement {
  key: string;
  kind: PickerGroupKind;
  name: string | null;
  subscription: boolean;
  needs: PickerGroup["needs"];
  blocked: PickerReasonKind | null;
}

/** The organization's group of a model's configuration, blocked by `blocked` when not served. */
function orgPlacement(
  model: PickerModel,
  config: PickerConfig | undefined,
  blocked: PickerReasonKind | null,
): Placement {
  const configId = model.config_id ?? null;
  return {
    key: `org:${configId ?? "managed"}`,
    kind: "org",
    // A managed alias hides its provider (`provider_name` is null): it is just « Clé org ».
    name: config?.label ?? model.provider_name ?? null,
    subscription: false,
    needs: null,
    blocked: model.enabled === false ? "disabled" : blocked,
  };
}

/** Why no organization connection serves a model: a dead one to reconnect, or none. */
function unservedByOrg(model: PickerModel, config: PickerConfig | undefined): PickerReasonKind {
  const dead = config
    ? config.org_connection === "needs_reconnection"
    : model.needs_reconnection === true;
  return dead ? "orgUnavailable" : "orgConnectionMissing";
}

function place(model: PickerModel, context: PickerContext): Placement {
  const own = context.credentials ?? [];
  const disabled = model.enabled === false;
  const config = context.configs?.find((candidate) => candidate.id === model.config_id);
  const scheduled = context.scheduled === true;

  if (model.billed_to === "system") {
    return {
      key: "system",
      kind: "system",
      name: null,
      subscription: false,
      needs: null,
      blocked: disabled ? "disabled" : null,
    };
  }

  if (model.billed_to === "org") return orgPlacement(model, config, null);

  if (model.billed_to === "user") {
    // A schedule has no payer of its own: the organization's connection serves it, or nothing.
    if (scheduled) {
      return orgPlacement(
        model,
        config,
        config?.org_connection === "active" || !context.configs
          ? null
          : unservedByOrg(model, config),
      );
    }
    const serving = servingCredential(model, own);
    return {
      key: `personal:${serving?.id ?? "unknown"}`,
      kind: "personal",
      name: serving?.label ?? null,
      subscription: serving?.subscription ?? false,
      needs: null,
      blocked: disabled ? "disabled" : null,
    };
  }

  // Nothing serves it for the caller: say what would. Until the configurations are known, no
  // reason is definitive.
  if (!context.configs) return orgPlacement(model, undefined, null);
  if (config?.personal_connections_allowed && !scheduled) {
    // The caller's own dead connection is theirs to reconnect; a dead organization one is not,
    // they can only add their own.
    const dead = own.some(
      (credential) => credential.configId === config.id && credential.needsReconnection,
    );
    const service = config.label;
    return {
      key: `personal-needs:${config.id}`,
      kind: "personal",
      name: service,
      subscription: false,
      needs: {
        service,
        fix: context.canConnect === true ? (dead ? "reconnect" : "add") : null,
      },
      blocked: disabled ? "disabled" : dead ? "personalReconnect" : "personalRequired",
    };
  }
  return orgPlacement(model, config, unservedByOrg(model, config));
}

/**
 * The picker's groups, in reading order: the organization's configurations, then the caller's
 * own connections, then the instance. A group the caller cannot use at all (no connection of
 * their own for a configuration) comes last, its models greyed with the reason.
 */
export function groupModelsForPicker(
  models: readonly PickerModel[],
  context: PickerContext = {},
): PickerGroup[] {
  const groups = new Map<string, PickerGroup>();
  for (const model of models) {
    const placement = place(model, context);
    let group = groups.get(placement.key);
    if (!group) {
      group = {
        key: placement.key,
        kind: placement.kind,
        name: placement.name,
        subscription: placement.subscription,
        needs: placement.needs,
        entries: [],
      };
      groups.set(placement.key, group);
    }
    group.entries.push({
      model,
      isDefault: model.is_default === true,
      blocked: placement.blocked,
    });
  }
  const rank = (group: PickerGroup) => (group.needs ? 3 : KIND_ORDER[group.kind]);
  return [...groups.values()].sort(
    (a, b) => rank(a) - rank(b) || (a.name ?? "").localeCompare(b.name ?? ""),
  );
}
