// SPDX-License-Identifier: Apache-2.0

import type { IntegrationAuthStatus } from "../hooks/use-integrations";

/** Auth keys are identifiers, not capabilities or steps the user must activate. */
export function authMethodLabel(
  auth: Pick<IntegrationAuthStatus, "auth_key" | "type">,
  auths: ReadonlyArray<Pick<IntegrationAuthStatus, "auth_key" | "type">>,
  typeLabel: string,
): string {
  return auths.filter((candidate) => candidate.type === auth.type).length > 1
    ? `${typeLabel} (${auth.auth_key})`
    : typeLabel;
}

export interface ConnectionAuthContext {
  authKey: string;
  /** The auth method itself can connect (an OAuth method needs its client configured). */
  methodReady: boolean;
  canCreate: boolean;
  /** The caller may renew this connection in place (`reconnect` action) and the method can. */
  canRenew: boolean;
}

/**
 * The org and space a renewal of an account-surface row is started in, or `null` when the caller
 * may not renew it (`reconnect` action) or no space can host the kickoff. The row's own space for a
 * space-scoped row, else the space that minted it, else the working space when the row belongs to
 * the working organization.
 */
export function reconnectScopeOf(
  conn: {
    allowed_actions: readonly string[];
    org: { id: string };
    space: { id: string } | null;
    origin_space: { id: string } | null;
  },
  working: { orgId: string | null | undefined; spaceId: string | null | undefined },
): { orgId: string; spaceId: string } | null {
  if (!conn.allowed_actions.includes("reconnect")) return null;
  const spaceId =
    conn.space?.id ??
    conn.origin_space?.id ??
    (conn.org.id === working.orgId ? working.spaceId : null);
  return spaceId ? { orgId: conn.org.id, spaceId } : null;
}
