// SPDX-License-Identifier: Apache-2.0

/**
 * Display name for an integration connection.
 *
 * `label` is the single source of truth: it's set at creation to the extracted
 * identity (email/login from `extractTokenIdentity`) or, for identity-less
 * credentials (api_key/basic/custom/PAT), to "Connexion N". The UI renders it
 * verbatim — no render-time fallback gymnastics.
 *
 * The identity/id fallbacks below only cover legacy rows written before the
 * label was always populated.
 */

interface ConnectionLabelFields {
  identityClaims?: Record<string, unknown> | null;
  accountId: string;
  label?: string | null;
}

/** Legacy identity (email/login) for rows predating always-set labels. */
function legacyIdentity(c: ConnectionLabelFields): string | null {
  const email =
    (c.identityClaims?.accountEmail as string | undefined) ??
    (c.identityClaims?.account_email as string | undefined);
  if (email) return email;
  if (c.accountId && c.accountId !== "default") return c.accountId;
  return null;
}

/** The connection's display name — `label`, with a legacy identity/id fallback. */
export function connectionDisplayLabel(c: ConnectionLabelFields): string {
  return c.label ?? legacyIdentity(c) ?? c.accountId;
}
