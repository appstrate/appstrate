// SPDX-License-Identifier: Apache-2.0

/**
 * One table for an auth's OAuth clients, out of the two lists the API serves.
 *
 * The server resolves a new connection's client as: the space's flagged client,
 * else the org's, else the system's (`pickDefault`). It answers that through two
 * lists: the SPACE list (the space's own clients, plus the inherited client when
 * it is the one in use) and the ORG list (the org's own clients, plus the system
 * client it would fall back on). Each marks its tier's effective default.
 *
 * Shown as two tables they repeat each other and carry two "default" columns
 * that mean different things. Merged, each client appears once, with its level,
 * whether THIS space uses it, and whether it is the organisation's default.
 */

import type { IntegrationClient } from "../hooks/use-integrations";

export type ClientLevel = "system" | "org" | "space";

export interface ClientRow {
  client: IntegrationClient;
  level: ClientLevel;
  /** New connections in this space use it. */
  usedHere: boolean;
  /** The organisation's default, which every space without its own inherits. */
  orgDefault: boolean;
  /** The space list carries it, so the space may choose it (`setDefault` on the space tier). */
  inSpaceList: boolean;
  /** The org list carries it, so an org admin may choose it for the organisation. */
  inOrgList: boolean;
}

export function clientLevel(client: IntegrationClient): ClientLevel {
  if (client.source === "built-in") return "system";
  if (client.source === "org") return "org";
  return "space";
}

const LEVEL_ORDER: Record<ClientLevel, number> = { space: 0, org: 1, system: 2 };

/**
 * Space clients first (they win), then the organisation's, then the system's;
 * within a level, the server's order. `orgClients` is undefined when the caller
 * may not read the org tier.
 */
export function mergeClientTiers(
  spaceClients: readonly IntegrationClient[],
  orgClients: readonly IntegrationClient[] | undefined,
): ClientRow[] {
  const rows = new Map<string, ClientRow>();
  for (const client of spaceClients) {
    rows.set(client.client_ref, {
      client,
      level: clientLevel(client),
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
        level: clientLevel(client),
        usedHere: false,
        orgDefault: client.is_default,
        inSpaceList: false,
        inOrgList: true,
      });
    }
  }
  return [...rows.values()].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}
