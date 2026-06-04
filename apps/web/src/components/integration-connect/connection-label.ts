// SPDX-License-Identifier: Apache-2.0

/**
 * Display name for an integration connection.
 *
 * `label` is the single source of truth: it's set at creation to the extracted
 * identity (email/login from `extractTokenIdentity`) or, for identity-less
 * credentials (api_key/basic/custom/PAT), to "Connexion N". The UI renders it
 * verbatim. The `?? accountId` tail only guards the optional `label` type — it
 * is always populated in practice.
 */

interface ConnectionLabelFields {
  account_id: string;
  label?: string | null;
}

/** The connection's display name. */
export function connectionDisplayLabel(c: ConnectionLabelFields): string {
  return c.label ?? c.account_id;
}
