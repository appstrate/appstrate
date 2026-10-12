// SPDX-License-Identifier: Apache-2.0

// `appstrate run --connection <integration>=<connection id>` — the launch body's
// `connection_overrides`, the same map on both launch routes (`--remote` and `--report`).

/** `{ "<integration id>": ["<connection id>", …] }`. */
export type ConnectionOverrides = Record<string, string[]>;

/** A usage error: `formatError` renders `<message> — <hint>`. */
class ConnectionFlagError extends Error {
  override readonly name = "ConnectionFlagError";
  readonly hint =
    "Pass --connection <integration>=<connection id> (e.g. --connection @scope/integration=<id>); repeat the flag to name several.";
}

/**
 * Fold the repeated `--connection` values into one set per integration, in the order given.
 * `undefined` when the flag was not passed: the launch body then carries no `connection_overrides`.
 * The first `=` separates: neither an integration id nor a connection id contains one.
 */
export function parseConnectionFlags(
  values: readonly string[] | undefined,
): ConnectionOverrides | undefined {
  if (!values || values.length === 0) return undefined;
  const sets = new Map<string, string[]>();
  for (const raw of values) {
    const eq = raw.indexOf("=");
    const integrationId = eq === -1 ? "" : raw.slice(0, eq).trim();
    const connectionId = raw.slice(eq + 1).trim();
    if (!integrationId || !connectionId) {
      throw new ConnectionFlagError(`Invalid --connection "${raw}"`);
    }
    sets.set(integrationId, [...(sets.get(integrationId) ?? []), connectionId]);
  }
  return Object.fromEntries(sets);
}
