// SPDX-License-Identifier: Apache-2.0

/**
 * One table for an auth's OAuth clients, merged from the two API lists. A new connection's client
 * is the space's flagged one, else the org's, else the system's (`pickDefault`). The SPACE list
 * holds the space's clients (plus the inherited one in use); the ORG list the org's (plus the
 * system fallback); each marks its tier's default. Shown separately the two repeat each other
 * under two "default" columns that mean different things.
 */

import type { IntegrationClient } from "../hooks/use-integrations";

export type ClientLevel = IntegrationClient["source"];

export interface ClientRow {
  client: IntegrationClient;
  level: ClientLevel;
  usedHere: boolean;
  orgDefault: boolean;
  /** The space may choose it. */
  inSpaceList: boolean;
  /** An org admin may choose it. */
  inOrgList: boolean;
}

const LEVEL_ORDER: Record<ClientLevel, number> = { space: 0, org: 1, system: 2 };

/** Space, then org, then system; server order within a level. `orgClients` is undefined when the caller may not read the org tier. */
export function mergeClientTiers(
  spaceClients: readonly IntegrationClient[],
  orgClients: readonly IntegrationClient[] | undefined,
): ClientRow[] {
  const rows = new Map<string, ClientRow>();
  for (const client of spaceClients) {
    rows.set(client.client_ref, {
      client,
      level: client.source,
      usedHere: client.is_default,
      orgDefault: false,
      inSpaceList: true,
      inOrgList: false,
    });
  }
  for (const client of orgClients ?? []) {
    const row = rows.get(client.client_ref);
    if (row) {
      row.inOrgList = true;
      row.orgDefault = client.is_default;
    } else {
      rows.set(client.client_ref, {
        client,
        level: client.source,
        usedHere: false,
        orgDefault: client.is_default,
        inSpaceList: false,
        inOrgList: true,
      });
    }
  }
  return [...rows.values()].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}
