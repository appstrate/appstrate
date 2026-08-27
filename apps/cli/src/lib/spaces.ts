// SPDX-License-Identifier: Apache-2.0

/**
 * Space helpers for the CLI — list, create, and resolve space
 * references.
 *
 * Mirror of `./orgs.ts`. Kept separate so both `login` (pin-on-first-use
 * cascade — org → space) and the new `space` subcommands share the same
 * parsing / validation + test surface.
 *
 * Server contract:
 *   - `GET /api/spaces` runs under org context (`X-Org-Id`) but
 *     does NOT require space context (`X-Space-Id`) — see
 *     `SPACE_SCOPED_PREFIXES` in `apps/api/src/middleware/space-context.ts`.
 *     That makes it
 *     safe to call immediately after an org is pinned and before the space
 *     cascade has chosen a default.
 *   - `POST /api/orgs` server-side also provisions a default space
 *     (`isDefault: true`, unique per-org), so `listSpaces` on a
 *     fresh org reliably returns at least one row.
 *   - `POST /api/spaces` requires session auth (rejected for API
 *     keys server-side) — the CLI uses the device-flow JWT, so this is
 *     always fine.
 */

import { apiFetch, apiList } from "./api.ts";

export interface Space {
  id: string;
  orgId: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
}

export async function listSpaces(profileName: string): Promise<Space[]> {
  return apiList<Space>(profileName, "/api/spaces");
}

export async function createSpace(profileName: string, name: string): Promise<Space> {
  return apiFetch<Space>(profileName, "/api/spaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

/**
 * Resolve a user-supplied space reference against the list returned
 * by `/api/spaces`. Spaces are identified by id only — the
 * server schema has no slug column (unlike orgs). Keep the name `*Ref`
 * for parallel symmetry with `resolveOrgRef` — the abstraction is the
 * same, only the matching attribute differs.
 *
 * Throws an Error whose `.message` lists the available spaces when
 * the ref doesn't match, including a `[default]` marker so the user sees
 * which one would be picked automatically at login / org switch.
 */
export function resolveSpaceRef(spaces: Space[], ref: string): Space {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    throw new Error("Space reference is empty.");
  }
  const match = spaces.find((s) => s.id === trimmed);
  if (match) return match;
  if (spaces.length === 0) {
    throw new Error(
      `No spaces found for this profile. Run \`appstrate space create <name>\` to create one.`,
    );
  }
  const available = spaces
    .map((s) => `  - ${s.name} (${s.id})${s.isDefault ? " [default]" : ""}`)
    .join("\n");
  throw new Error(`No space matches "${trimmed}". Available:\n${available}`);
}

/**
 * Return the `isDefault: true` space, if any. Used by the login org→space
 * cascade and by `org switch` / `org create` re-pin helpers — the server
 * guarantees exactly one default per org, so this is a single-step look.
 */
export function findDefaultSpace(spaces: Space[]): Space | undefined {
  return spaces.find((s) => s.isDefault);
}
