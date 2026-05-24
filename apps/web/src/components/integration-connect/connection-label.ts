// SPDX-License-Identifier: Apache-2.0

/**
 * Human label helpers for an integration connection. Centralises the
 * identity precedence so the rule (and its camelCase/snake_case
 * identity-claim dual-keying) lives once instead of being inlined at every
 * connection-picker site.
 *
 * `accountId` is the value `extractTokenIdentity` produced at connect time —
 * an email/login for OAuth integrations that map one, or the resolver floor
 * `"default"` for identity-less credentials (api_key/basic/custom/PAT). The
 * floor is treated as "no identity": callers pass a localized `fallback`
 * (e.g. "Connexion 2") so a connection without an extracted identity or a
 * user label never renders as the meaningless "default".
 */

interface ConnectionLabelFields {
  identityClaims?: Record<string, unknown> | null;
  accountId: string;
  label?: string | null;
}

/** The extracted identity (email when known, else a non-floor accountId), or
 *  `null` when `extractTokenIdentity` produced nothing. */
export function connectionAccount(c: ConnectionLabelFields): string | null {
  const email =
    (c.identityClaims?.accountEmail as string | undefined) ??
    (c.identityClaims?.account_email as string | undefined);
  if (email) return email;
  if (c.accountId && c.accountId !== "default") return c.accountId;
  return null;
}

/**
 * Display label. Precedence: user label (with the account in parens when an
 * identity is also known) → extracted identity → caller-supplied localized
 * `fallback` for connections with neither.
 */
export function connectionDisplayLabel(c: ConnectionLabelFields, fallback = ""): string {
  const account = connectionAccount(c);
  if (c.label) return account ? `${c.label} (${account})` : c.label;
  return account ?? fallback;
}
