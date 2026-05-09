// SPDX-License-Identifier: Apache-2.0

/**
 * Connection-profile helpers for the CLI — list, create, switch, and
 * resolve `<id|name>` references against `/api/connection-profiles`.
 *
 * Mirror of `./applications.ts`. Kept separate so the new
 * `appstrate connections` subcommand and the `--connection-profile`
 * flag share the same parsing + validation surface.
 *
 * Server contract:
 *   - `GET /api/connection-profiles` returns all profiles owned by the
 *     authenticated user, including a `connectionCount`.
 *   - `POST /api/connection-profiles` creates a non-default profile.
 *
 * Resolution semantics:
 *   - UUID v4 → assumed-id, returned verbatim after a list-and-match
 *     verification.
 *   - Anything else → name lookup on the user's own profiles. Names
 *     are unique per user, so the first match wins.
 *   - No match → throws with the available list so the user can fix it
 *     with one paste.
 */

import { apiFetch, apiList } from "./api.ts";
import type { ConnectionProfile as DbConnectionProfile } from "@appstrate/shared-types";

/**
 * Connection profile as returned by `GET /api/connection-profiles` —
 * the DB row enriched with the API-side `connectionCount` aggregate.
 * Mirrors the dashboard's `ProfileWithConnections` shape so both
 * clients reason about the same payload.
 *
 * The DB row models `createdAt`/`updatedAt` as `Date`, but JSON
 * serialization replaces them with ISO 8601 strings on the wire — we
 * narrow the type to reflect what the CLI actually receives.
 */
export interface ConnectionProfile extends Omit<DbConnectionProfile, "createdAt" | "updatedAt"> {
  connectionCount: number;
  createdAt: string;
  updatedAt: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export async function listConnectionProfiles(profileName: string): Promise<ConnectionProfile[]> {
  return apiList<ConnectionProfile>(profileName, "/api/connection-profiles");
}

export async function createConnectionProfile(
  profileName: string,
  name: string,
): Promise<ConnectionProfile> {
  const res = await apiFetch<{ profile: ConnectionProfile }>(
    profileName,
    "/api/connection-profiles",
    {
      method: "POST",
      body: JSON.stringify({ name }),
    },
  );
  return res.profile;
}

/**
 * Resolve `<ref>` to a profile. Accepts either a UUID v4 (looked up by
 * id) or a name (case-sensitive match against the actor's own profiles).
 * Throws `Error` whose `.message` lists the available profiles when the
 * ref does not match.
 */
export function resolveConnectionProfileRef(
  profiles: ConnectionProfile[],
  ref: string,
): ConnectionProfile {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    throw new Error("Connection profile reference is empty.");
  }
  if (isUuid(trimmed)) {
    const match = profiles.find((p) => p.id === trimmed);
    if (match) return match;
    throw new Error(
      `No connection profile matches id "${trimmed}". Run \`appstrate connections profile list\` to see available profiles.`,
    );
  }
  const match = profiles.find((p) => p.name === trimmed);
  if (match) return match;
  if (profiles.length === 0) {
    throw new Error(
      `No connection profiles found for this user. Run \`appstrate connections profile create <name>\` to create one.`,
    );
  }
  const available = profiles
    .map((p) => `  - ${p.name} (${p.id})${p.isDefault ? " [default]" : ""}`)
    .join("\n");
  throw new Error(`No connection profile matches "${trimmed}". Available:\n${available}`);
}

/**
 * Listing aggregator for `appstrate connections list` — returns the
 * current actor's connections, scoped via `/api/connections`.
 */
export interface UserConnection {
  id: string;
  providerId: string;
  profileId: string;
  profileName: string;
  status: string;
  createdAt: string;
}

interface ConnectionsListResponse {
  data?: Array<{
    providerId: string;
    orgs?: Array<{
      orgId: string;
      connections?: Array<{
        id: string;
        status: string;
        createdAt: string;
        profile: { id: string; name: string };
      }>;
    }>;
  }>;
}

export async function listUserConnections(profileName: string): Promise<UserConnection[]> {
  const res = await apiFetch<ConnectionsListResponse>(profileName, "/api/app-profiles/connections");
  const out: UserConnection[] = [];
  for (const provider of res.data ?? []) {
    for (const org of provider.orgs ?? []) {
      for (const conn of org.connections ?? []) {
        out.push({
          id: conn.id,
          providerId: provider.providerId,
          profileId: conn.profile.id,
          profileName: conn.profile.name,
          status: conn.status,
          createdAt: conn.createdAt,
        });
      }
    }
  }
  return out;
}
