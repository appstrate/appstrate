// SPDX-License-Identifier: Apache-2.0

/**
 * A connection's variables (AFPS §7.12) as the run-time renderers read them: the values that
 * choose its upstream, paired with the credential acquired for that upstream.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationConnections } from "@appstrate/db/schema";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { getVariablesSchema } from "./integration-manifest-helpers.ts";

export type ConnectionVariables = Readonly<Record<string, string>>;

const NO_VARIABLES: ConnectionVariables = Object.freeze({});

/**
 * The variables stored with `connection`'s credential. `{}` without a query when the manifest
 * declares none; `null` when the row no longer holds that ciphertext — a reconnect rewrites the
 * credential and the variables together, so values read after it could name another upstream
 * than the credential the caller decrypted.
 */
export async function readConnectionVariables(
  manifest: IntegrationManifest,
  connection: { id: string; credentialsEncrypted: string },
): Promise<ConnectionVariables | null> {
  if (getVariablesSchema(manifest) === null) return NO_VARIABLES;
  const [row] = await db
    .select({ variables: integrationConnections.variables })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.id, connection.id),
        eq(integrationConnections.credentialsEncrypted, connection.credentialsEncrypted),
      ),
    )
    .limit(1);
  if (!row) return null;
  return stringEntries(row.variables);
}

/** Only own string values: the column is jsonb, and a renderer substitutes what it is given. */
function stringEntries(value: unknown): ConnectionVariables {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return NO_VARIABLES;
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(value)) if (typeof v === "string") out[name] = v;
  return Object.freeze(out);
}
