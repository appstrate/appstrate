// SPDX-License-Identifier: Apache-2.0

/**
 * What a PERSON can pick in a model list, grouped by who pays for the call.
 *
 * Pure: no React, no I/O. The dashboard's pickers (an agent's Modèle section, a schedule's
 * Exécution, a run with options) and the chat's composer all feed `GET /api/models` through
 * here, so the same model reads the same way everywhere.
 *
 * `GET /api/models` already says, FOR THE CALLER, how each model is served:
 *  - `binding: "system"` / `billed_to: "system"`: the instance's own key (a built-in model);
 *  - `binding: "org"` / `billed_to: "org"`: bound to one organization credential;
 *  - `binding: "user"`: unbound, each person serves it with a credential of their own. Then
 *    `billed_to: "user"` says one of the caller's serves it, `null` says none does.
 * The groups are that, plus the caller's own credentials to NAME the group (« Ma clé perso »).
 */

export type PickerPayer = "system" | "org" | "user" | null;

/** The fields of an `OrgModel` the picker reads (structural: web and chat rows both fit). */
export interface PickerModel {
  id: string;
  label: string | null;
  /** Upstream model id; `null` for a managed alias. */
  modelId: string | null;
  providerId?: string | null;
  provider_name?: string | null;
  binding?: "system" | "org" | "user" | "managed";
  credentialId?: string | null;
  billed_to?: PickerPayer;
  enabled?: boolean;
  needs_reconnection?: boolean;
  is_default?: boolean;
}

/** A credential that names a group: the organization's, or one of the caller's own. */
export interface PickerCredential {
  id: string;
  label: string;
  owner: "org" | "me";
  /** A subscription (« Abonnement perso »), as opposed to an API key. */
  subscription: boolean;
  /** Upstream model ids it serves (the provider registry's catalog); read for `owner: "me"`. */
  modelIds: readonly string[];
}

export type PickerReasonKind =
  | "disabled"
  | "orgUnavailable"
  | "personalRequired"
  | "personalReconnect"
  | "personalOff"
  | "notSchedulable";

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
  /** The credential's name, or the service when the person has none yet; `null` when unnamed. */
  name: string | null;
  /** A personal group served by a subscription (« Abonnement perso »). */
  subscription: boolean;
  /** Personal models the caller has no working credential for: what they can do about it. */
  needs: { service: string | null; fix: "add" | "reconnect" | null } | null;
  entries: PickerEntry[];
}

export interface PickerContext {
  /** The caller's own credentials, and the organization's when the caller may read them. */
  credentials?: readonly PickerCredential[];
  /** The organization lets members bring their own credentials (`personal_model_credentials`); `undefined` until known. */
  personalAllowed?: boolean;
  /** The caller may add or reconnect a credential of their own (`model-provider-credentials:connect`). */
  canConnect?: boolean;
  /** A schedule runs alone: no model served by a personal credential. */
  scheduled?: boolean;
}

const KIND_ORDER = { org: 0, personal: 1, system: 2 } as const;

function servingCredential(
  model: PickerModel,
  own: readonly PickerCredential[],
): PickerCredential | undefined {
  if (model.modelId === null) return undefined;
  // The server tries subscriptions first, then keys.
  return [...own]
    .sort((a, b) => Number(b.subscription) - Number(a.subscription))
    .find((credential) => credential.modelIds.includes(model.modelId!));
}

interface Placement {
  key: string;
  kind: PickerGroupKind;
  name: string | null;
  subscription: boolean;
  needs: PickerGroup["needs"];
  blocked: PickerReasonKind | null;
}

function place(model: PickerModel, context: PickerContext): Placement {
  const credentials = context.credentials ?? [];
  const own = credentials.filter((credential) => credential.owner === "me");
  const disabled = model.enabled === false;

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

  if (model.binding === "user") {
    const notSchedulable = context.scheduled === true;
    if (model.billed_to === "user") {
      const serving = servingCredential(model, own);
      return {
        key: `personal:${serving?.id ?? "unknown"}`,
        kind: "personal",
        name: serving?.label ?? null,
        subscription: serving?.subscription ?? false,
        needs: null,
        blocked: disabled ? "disabled" : notSchedulable ? "notSchedulable" : null,
      };
    }
    // Nothing of the caller's serves it: say what would.
    const service = model.provider_name ?? null;
    const reconnect = model.needs_reconnection === true;
    const off = context.personalAllowed === false;
    const canFix = !notSchedulable && !off && context.canConnect === true;
    return {
      key: `personal-needs:${model.providerId ?? service ?? "unknown"}`,
      kind: "personal",
      name: service,
      subscription: false,
      needs: { service, fix: canFix ? (reconnect ? "reconnect" : "add") : null },
      blocked: disabled
        ? "disabled"
        : notSchedulable
          ? "notSchedulable"
          : off
            ? "personalOff"
            : reconnect
              ? "personalReconnect"
              : "personalRequired",
    };
  }

  const credentialId = model.credentialId ?? null;
  const credential = credentialId
    ? credentials.find((candidate) => candidate.id === credentialId)
    : undefined;
  return {
    key: `org:${credentialId ?? "managed"}`,
    kind: "org",
    // A managed alias hides its binding: it is just « Clé org ».
    name: credential?.label ?? (model.binding === "managed" ? null : (model.provider_name ?? null)),
    subscription: false,
    needs: null,
    blocked: disabled ? "disabled" : model.needs_reconnection ? "orgUnavailable" : null,
  };
}

/**
 * The picker's groups, in reading order: the organization's credentials, then the caller's own,
 * then the instance. A group the caller cannot use at all (no credential of their own for a
 * service) comes last, its models greyed with the reason.
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
