// SPDX-License-Identifier: Apache-2.0

// What names a connection's upstream: its account and its variables (AFPS §7.12). Pure, so the
// resolver and the credential writer read the same rule.

import type { ConnectionVariables } from "../services/connect/connection-variables.ts";

/** `account_id` of an identity-less connection (`extractIdentity` found no claim). */
export const PLACEHOLDER_ACCOUNT_ID = "default";

export function displayAccountId(accountId: string | null | undefined): string | null {
  return accountId && accountId !== PLACEHOLDER_ACCOUNT_ID ? accountId : null;
}

/** Whether two connections name the same upstream: the same variables, the same values. */
export function sameConnectionVariables(a: ConnectionVariables, b: ConnectionVariables): boolean {
  const entries = Object.entries(a);
  return entries.length === Object.keys(b).length && entries.every(([k, v]) => b[k] === v);
}

/** Own string values only: the column is jsonb, and a renderer substitutes what it is given. */
export function connectionVariablesOf(value: unknown): ConnectionVariables {
  const out: Record<string, string> = {};
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [name, v] of Object.entries(value)) if (typeof v === "string") out[name] = v;
  }
  return Object.freeze(out);
}
