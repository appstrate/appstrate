// SPDX-License-Identifier: Apache-2.0

/**
 * Org helpers for the CLI — list, create, and resolve org references.
 *
 * These are thin `apiFetch` wrappers. Kept in their own module so both
 * `login` (pin-on-first-use) and the new `org` subcommands share the
 * same parsing / validation + test surface.
 *
 * Server contract:
 *   - `GET /api/orgs` and `POST /api/orgs` both run without org context
 *     (no `X-Org-Id`), so they work right after a fresh login before
 *     the profile has a pinned org. See `apps/api/src/routes/organizations.ts`.
 *   - Creating an org server-side also provisions a default application
 *     + hello-world agent, so the user lands on a fully-working setup.
 */

import { apiFetch } from "./api.ts";

export interface Org {
  id: string;
  name: string;
  slug: string;
  role: string;
  createdAt: string;
}

interface ListResponse {
  object: "list";
  data: Org[];
  hasMore: boolean;
}

export async function listOrgs(profileName: string): Promise<Org[]> {
  const res = await apiFetch<ListResponse>(profileName, "/api/orgs");
  return Array.isArray(res.data) ? res.data : [];
}

export interface CreateOrgInput {
  name: string;
  slug?: string;
}

export async function createOrg(profileName: string, input: CreateOrgInput): Promise<Org> {
  const body: Record<string, string> = { name: input.name };
  if (input.slug && input.slug.length > 0) body.slug = input.slug;
  return apiFetch<Org>(profileName, "/api/orgs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Resolve a user-supplied org reference (id or slug) against the list
 * returned by `/api/orgs`. The CLI accepts either so scripts and humans
 * can write whichever they have on hand. Exact match only — we do NOT
 * do substring / fuzzy matching because a typo silently picking a
 * different org than the user meant is a genuine footgun.
 *
 * Throws an Error with a listing of the valid options when the ref
 * doesn't match — surfaces nicely through `formatError` in `ui.ts`.
 */
export function resolveOrgRef(orgs: Org[], ref: string): Org {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    throw new Error("Org reference is empty.");
  }
  const match = orgs.find((o) => o.id === trimmed || o.slug === trimmed);
  if (match) return match;
  if (orgs.length === 0) {
    throw new Error(
      `No organizations found for this profile. Run \`appstrate org create\` to create one.`,
    );
  }
  const available = orgs.map((o) => `  - ${o.slug} (${o.id})`).join("\n");
  throw new Error(`No organization matches "${trimmed}". Available:\n${available}`);
}
