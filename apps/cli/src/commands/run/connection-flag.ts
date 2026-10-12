// SPDX-License-Identifier: Apache-2.0

import type { ConnectionOverrides } from "@appstrate/core/integration";

/**
 * The repeated `--connection <integration>=<connection-id>` values as the launch body's
 * `connection_overrides`: one set per integration, in the order given, split on the first `=`.
 */
export function parseConnectionFlags(values: readonly string[]): ConnectionOverrides | undefined {
  if (values.length === 0) return undefined;
  const sets = new Map<string, string[]>();
  for (const raw of values) {
    const eq = raw.indexOf("=");
    if (eq <= 0 || eq === raw.length - 1) {
      throw new Error(`Invalid --connection "${raw}" (expected <integration>=<connection-id>)`);
    }
    const integrationId = raw.slice(0, eq);
    sets.set(integrationId, [...(sets.get(integrationId) ?? []), raw.slice(eq + 1)]);
  }
  return Object.fromEntries(sets);
}
