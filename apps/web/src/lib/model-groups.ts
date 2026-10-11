// SPDX-License-Identifier: Apache-2.0

/**
 * How the organization's models are grouped on the Models page: one group per
 * provider of the organization (an API key a model is bound to), then the models
 * each person serves with their own provider, then the models the instance ships.
 *
 * A provider the caller cannot read (a role with `models:read` alone) has no
 * credential row to name it: its models still group under it, named by the
 * service they run on.
 */

import type { ModelProviderCredentialInfo } from "../hooks/use-model-provider-credentials";
import type { OrgModelInfo } from "../hooks/use-models";

export type ModelGroup =
  | {
      kind: "provider";
      key: string;
      /** `null` when the caller cannot read the organization's credentials. */
      credential: ModelProviderCredentialInfo | null;
      /** The service's name, used when there is no credential row to name the group. */
      serviceName: string | null;
      models: OrgModelInfo[];
    }
  | { kind: "personal"; key: "personal"; models: OrgModelInfo[] }
  | { kind: "system"; key: "system"; models: OrgModelInfo[] };

/** The credentials an organization model may be bound to: the organization's own API keys. */
function organizationProviders(
  credentials: readonly ModelProviderCredentialInfo[],
): ModelProviderCredentialInfo[] {
  return credentials.filter((c) => c.owner_type === "org" && c.source === "custom" && c.bindable);
}

export function groupModels(
  models: readonly OrgModelInfo[],
  credentials: readonly ModelProviderCredentialInfo[],
): ModelGroup[] {
  const system = models.filter((m) => m.source === "built-in" || m.binding === "managed");
  const personal = models.filter((m) => m.binding === "member" && !system.includes(m));
  const bound = models.filter((m) => !system.includes(m) && !personal.includes(m));

  const known = organizationProviders(credentials);
  const groups: ModelGroup[] = known.map((credential) => ({
    kind: "provider",
    key: credential.id,
    credential,
    serviceName: null,
    models: bound.filter((m) => m.credentialId === credential.id),
  }));

  // Models bound to a provider the caller does not see.
  const unseen = new Map<string, OrgModelInfo[]>();
  for (const m of bound) {
    if (m.credentialId === null || known.some((c) => c.id === m.credentialId)) continue;
    unseen.set(m.credentialId, [...(unseen.get(m.credentialId) ?? []), m]);
  }
  for (const [credentialId, rows] of unseen) {
    groups.push({
      kind: "provider",
      key: credentialId,
      credential: null,
      serviceName: rows[0]?.provider_name ?? null,
      models: rows,
    });
  }

  if (personal.length > 0) groups.push({ kind: "personal", key: "personal", models: personal });
  if (system.length > 0) groups.push({ kind: "system", key: "system", models: system });
  return groups;
}

/** A model the caller may change: the organization's own, not a system one or a managed alias. */
export function isModelEditable(m: OrgModelInfo, canWrite: boolean): boolean {
  return m.source !== "built-in" && !m.aliased && canWrite;
}
