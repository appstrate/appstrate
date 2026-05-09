// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve `<id|name>` references for `--connection-profile` and
 * `--provider-profile <p>=<id|name>` flags into UUIDs the resolver can
 * forward as `X-Connection-Profile-Id` headers.
 *
 * Two sources for the per-run default:
 *   1. `--connection-profile` flag (per-call override)
 *   2. `connectionProfileId` pinned on the CLI profile (sticky default
 *      written by `appstrate connections profile switch`)
 *
 * UUIDs pass through verbatim. Names hit the API to translate, only on
 * the path that needs translation — saving a round-trip when the user
 * already knows the id (CI environments) or has nothing to resolve at all.
 */

import {
  isUuid,
  listConnectionProfiles,
  type ConnectionProfile,
} from "../../lib/connection-profiles.ts";

export class ConnectionProfileResolutionError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "ConnectionProfileResolutionError";
  }
}

export interface ProviderProfileOverride {
  providerId: string;
  ref: string;
}

/**
 * Parse `--provider-profile <p>=<id|name>` raw values into structured
 * pairs. Each entry must contain exactly one `=`; the LHS is the
 * provider id (`@scope/provider`), the RHS is the unresolved reference.
 */
export function parseProviderProfileOverrides(
  raw: string[] | undefined,
): ProviderProfileOverride[] {
  if (!raw || raw.length === 0) return [];
  return raw.map((entry) => {
    const eq = entry.indexOf("=");
    if (eq <= 0 || eq === entry.length - 1) {
      throw new ConnectionProfileResolutionError(
        `Invalid --provider-profile "${entry}"`,
        "Expected format: <providerId>=<id|name>, e.g. --provider-profile @afps/gmail=work.",
      );
    }
    const providerId = entry.slice(0, eq).trim();
    const ref = entry.slice(eq + 1).trim();
    if (!providerId || !ref) {
      throw new ConnectionProfileResolutionError(
        `Invalid --provider-profile "${entry}"`,
        "Both provider id and profile ref must be non-empty.",
      );
    }
    return { providerId, ref };
  });
}

export interface ConnectionProfileSelectionInputs {
  /** CLI profile (only used when a name needs API translation). */
  profileName: string;
  /** `--connection-profile <id|name>` flag value, if set. */
  flagRef?: string;
  /** Sticky default from `Profile.connectionProfileId`, if set. */
  pinnedId?: string;
  /** Parsed `--provider-profile` entries. */
  perProvider?: ProviderProfileOverride[];
  /**
   * Test-only override. Production resolves names against the CLI
   * config + keyring via `listConnectionProfiles`.
   */
  fetchProfiles?: (profileName: string) => Promise<ConnectionProfile[]>;
}

export interface ConnectionProfileSelection {
  /** Resolved default profile id (for `X-Connection-Profile-Id`), or undefined. */
  connectionProfileId: string | undefined;
  /** `{ providerId: connectionProfileId }` map applied per-call by the resolver. */
  providerProfileOverrides: Record<string, string>;
}

/**
 * Resolve the per-call default profile + per-provider overrides, hitting
 * the API only if at least one ref is a name (not a UUID).
 */
export async function resolveConnectionProfileSelection(
  inputs: ConnectionProfileSelectionInputs,
): Promise<ConnectionProfileSelection> {
  const fetcher = inputs.fetchProfiles ?? listConnectionProfiles;
  const flag = inputs.flagRef?.trim();
  const perProvider = inputs.perProvider ?? [];

  // Fast path — every reference is already a UUID. Skip the API.
  const flagIsUuid = !flag || isUuid(flag);
  const allOverridesUuid = perProvider.every((p) => isUuid(p.ref));
  if (flagIsUuid && allOverridesUuid) {
    return {
      connectionProfileId: flag ?? inputs.pinnedId,
      providerProfileOverrides: Object.fromEntries(perProvider.map((p) => [p.providerId, p.ref])),
    };
  }

  // At least one name — load the user's profiles once and translate
  // every name in a single pass.
  const profiles = await fetcher(inputs.profileName);
  const byName = new Map(profiles.map((p) => [p.name, p.id] as const));
  const byId = new Map(profiles.map((p) => [p.id, p.id] as const));

  const resolveRef = (ref: string, source: string): string => {
    if (isUuid(ref)) {
      const match = byId.get(ref);
      if (!match) {
        throw new ConnectionProfileResolutionError(
          `No connection profile matches id "${ref}" (${source})`,
          "Run `appstrate connections profile list` to see available profiles.",
        );
      }
      return match;
    }
    const match = byName.get(ref);
    if (!match) {
      const available = profiles.map((p) => `  - ${p.name} (${p.id})`).join("\n");
      throw new ConnectionProfileResolutionError(
        `No connection profile matches "${ref}" (${source})`,
        profiles.length === 0
          ? "Run `appstrate connections profile create <name>` to create one."
          : `Available:\n${available}`,
      );
    }
    return match;
  };

  const connectionProfileId = flag
    ? resolveRef(flag, "--connection-profile")
    : (inputs.pinnedId ?? undefined);

  const providerProfileOverrides: Record<string, string> = {};
  for (const entry of perProvider) {
    providerProfileOverrides[entry.providerId] = resolveRef(
      entry.ref,
      `--provider-profile ${entry.providerId}`,
    );
  }

  return { connectionProfileId, providerProfileOverrides };
}
