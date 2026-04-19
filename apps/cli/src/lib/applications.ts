// SPDX-License-Identifier: Apache-2.0

/**
 * Application helpers for the CLI — list, create, and resolve application
 * references.
 *
 * Mirror of `./orgs.ts`. Kept separate so both `login` (pin-on-first-use
 * cascade — org → app) and the new `app` subcommands share the same
 * parsing / validation + test surface.
 *
 * Server contract:
 *   - `GET /api/applications` runs under org context (`X-Org-Id`) but
 *     does NOT require app context (`X-App-Id`) — see
 *     `apps/api/src/index.ts` `CORE_APP_SCOPED_PREFIXES`. That makes it
 *     safe to call immediately after an org is pinned and before the app
 *     cascade has chosen a default.
 *   - `POST /api/orgs` server-side also provisions a default application
 *     (`isDefault: true`, unique per-org), so `listApplications` on a
 *     fresh org reliably returns at least one row.
 *   - `POST /api/applications` requires session auth (rejected for API
 *     keys server-side) — the CLI uses the device-flow JWT, so this is
 *     always fine.
 */

import { apiFetch } from "./api.ts";

export interface Application {
  id: string;
  orgId: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
}

interface ListResponse {
  data?: Application[];
}

export async function listApplications(profileName: string): Promise<Application[]> {
  const res = await apiFetch<ListResponse>(profileName, "/api/applications");
  return Array.isArray(res.data) ? res.data : [];
}

export async function createApplication(profileName: string, name: string): Promise<Application> {
  return apiFetch<Application>(profileName, "/api/applications", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

/**
 * Resolve a user-supplied application reference against the list returned
 * by `/api/applications`. Applications are identified by id only — the
 * server schema has no slug column (unlike orgs). Keep the name `*Ref`
 * for parallel symmetry with `resolveOrgRef` — the abstraction is the
 * same, only the matching attribute differs.
 *
 * Throws an Error whose `.message` lists the available applications when
 * the ref doesn't match, including a `[default]` marker so the user sees
 * which one would be picked automatically at login / org switch.
 */
export function resolveApplicationRef(apps: Application[], ref: string): Application {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    throw new Error("Application reference is empty.");
  }
  const match = apps.find((a) => a.id === trimmed);
  if (match) return match;
  if (apps.length === 0) {
    throw new Error(
      `No applications found for this profile. Run \`appstrate app create <name>\` to create one.`,
    );
  }
  const available = apps
    .map((a) => `  - ${a.name} (${a.id})${a.isDefault ? " [default]" : ""}`)
    .join("\n");
  throw new Error(`No application matches "${trimmed}". Available:\n${available}`);
}

/**
 * Return the `isDefault: true` app, if any. Used by the login org→app
 * cascade and by `org switch` / `org create` re-pin helpers — the server
 * guarantees exactly one default per org, so this is a single-step look.
 */
export function findDefaultApplication(apps: Application[]): Application | undefined {
  return apps.find((a) => a.isDefault);
}
