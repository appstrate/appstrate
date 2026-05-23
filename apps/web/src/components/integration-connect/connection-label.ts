// SPDX-License-Identifier: Apache-2.0

/**
 * Human label helpers for an integration connection. Centralises the
 * `accountEmail ?? account_email ?? accountId` precedence so the rule
 * (and its camelCase/snake_case identity-claim dual-keying) lives once
 * instead of being inlined at every connection-picker site.
 */

interface ConnectionLabelFields {
  identityClaims?: Record<string, unknown> | null;
  accountId: string;
  label?: string | null;
}

/** The account identifier shown for a connection (email when known, else id). */
export function connectionAccount(c: ConnectionLabelFields): string {
  return (
    (c.identityClaims?.accountEmail as string | undefined) ??
    (c.identityClaims?.account_email as string | undefined) ??
    c.accountId
  );
}

/** Display label: `"<label> (<account>)"` when the user named it, else the bare account. */
export function connectionDisplayLabel(c: ConnectionLabelFields): string {
  const account = connectionAccount(c);
  return c.label ? `${c.label} (${account})` : account;
}
