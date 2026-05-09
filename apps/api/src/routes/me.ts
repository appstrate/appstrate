// SPDX-License-Identifier: Apache-2.0

/**
 * User-scoped identity routes (`/api/me/*`).
 *
 * `/api/orgs` is dashboard-only (cookie session) and refuses every other auth
 * method via the implicit `requireOrgContext` chicken-and-egg: a non-dashboard
 * caller (SPA over OAuth, CLI, module over Bearer JWT) can't list its orgs
 * because listing orgs is what tells it which `X-Org-Id` to set in the first
 * place.
 *
 * The `/api/me/*` namespace solves that — these routes:
 *   - skip `requireOrgContext` so the caller doesn't need `X-Org-Id` upfront
 *     (`/api/me/orgs` is the prerequisite to setting it; `/api/me/models`
 *     uses the org already pinned by the strategy or `X-Org-Id`),
 *   - accept every auth method that represents a single user (cookie session,
 *     API key, OAuth2 instance/dashboard/end-user JWTs),
 *   - return only the data the caller is entitled to (API key sees its
 *     bound org, OIDC end-user sees their application's owning org,
 *     dashboard user sees every org they're a member of).
 *
 * Scope intentionally tight: only the two reads above. Adding a new field
 * to `/api/me/*` requires its own named route — we are NOT going to grow
 * a catch-all user-profile endpoint here.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { getOrgById, getUserOrganizations } from "../services/organizations.ts";
import { listOrgModels } from "../services/org-models.ts";
import {
  getMemberApplicationProfileId,
  setMemberApplicationProfileId,
  clearMemberApplicationProfile,
} from "../services/connection-profiles.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { requireAppContext } from "../middleware/app-context.ts";
import { parseBody, unauthorized } from "../lib/errors.ts";
import { listResponse } from "../lib/list-response.ts";

const router = new Hono<AppEnv>();

/**
 * GET /api/me/orgs — list orgs the authenticated caller belongs to.
 *
 * - Cookie session / OIDC dashboard JWT: every org the BA user is a member of
 * - API key: the single org the key is bound to (DB-level filter — a
 *   compromised key cannot enumerate every org the creator belongs to)
 * - OIDC end-user JWT: the single org owning the impersonated end-user's
 *   application (end-users are not org members; the org is derived from
 *   `endUser.applicationId`)
 *
 * Skips `requireOrgContext` (no `X-Org-Id` required — listing orgs is the
 * prerequisite to setting it). Authentication itself is enforced by the
 * shared auth pipeline before this handler runs.
 */
router.get("/orgs", async (c) => {
  const endUser = c.get("endUser");
  if (endUser) {
    // End-users are not in `organization_members` — the OIDC strategy already
    // pinned their application's owning org on `c.set("orgId", ...)`. Reuse
    // that single id and return a one-element list so the SPA org picker
    // has a stable shape across auth methods.
    const orgId = c.get("orgId");
    if (!orgId) return c.json(listResponse([]));
    const org = await getOrgById(orgId);
    if (!org) return c.json(listResponse([]));
    return c.json(
      listResponse([
        {
          id: org.id,
          name: org.name,
          slug: org.slug,
          // End-users have no org role — surface a stable string instead
          // of `undefined` so the consumer doesn't have to special-case it.
          role: "end_user" as const,
          createdAt: org.createdAt,
        },
      ]),
    );
  }

  const user = c.get("user");
  if (!user) throw unauthorized("Authentication required");

  // API keys are bound to a single org — filter at the DB level so a
  // compromised key cannot enumerate every org the creator belongs to.
  // Same rule as `GET /api/orgs` keeps the two paths in lockstep.
  const orgIdFilter = c.get("authMethod") === "api_key" ? c.get("orgId") : undefined;
  const orgs = await getUserOrganizations(user.id, orgIdFilter);

  return c.json(
    listResponse(
      orgs.map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        role: o.role,
        createdAt: o.createdAt,
      })),
    ),
  );
});

/**
 * GET /api/me/models — list models available in the active org.
 *
 * Requires `models:read`. Org context is set by:
 *   - cookie session: `X-Org-Id` header (resolved by `requireOrgContext`)
 *   - API key: bound org (resolved by the API-key auth branch)
 *   - OIDC dashboard JWT: `org_id` claim (set inline by the strategy)
 *   - OIDC end-user JWT: org owning the application (set inline by the strategy)
 *
 * Returns the same shape as `listOrgModels` — the catalog the SPA model
 * picker consumes. The route layer never exposes decrypted credentials;
 * `apiKey` is intentionally omitted from the catalog DTO.
 */
router.get("/models", requirePermission("models", "read"), async (c) => {
  const orgId = c.get("orgId");
  const models = await listOrgModels(orgId);
  return c.json(listResponse(models));
});

/**
 * `/api/me/application-profile` — per-(member, application) sticky default
 * connection profile. Lets a dashboard user pin which connection profile
 * their runs in this application use by default, sitting between the
 * explicit per-run override (`X-Connection-Profile-Id`) and the application
 * default in the credential proxy's `resolveProfileId` cascade.
 *
 * Member-only: end-users have their own auto-created default elsewhere on
 * `connection_profiles` itself, so these routes reject `endUser`-bound
 * callers. The application id comes from `requireAppContext()` (header
 * `X-Application-Id` for cookie sessions, embedded for API keys).
 */
const setProfileSchema = z.object({ connectionProfileId: z.uuid() });

router.get("/application-profile", requireAppContext(), async (c) => {
  const user = c.get("user");
  if (!user) throw unauthorized("Authentication required");
  if (c.get("endUser")) {
    return c.json({ connectionProfileId: null });
  }
  const applicationId = c.get("applicationId")!;
  const connectionProfileId = await getMemberApplicationProfileId(user.id, applicationId);
  return c.json({ connectionProfileId });
});

router.put("/application-profile", requireAppContext(), async (c) => {
  const user = c.get("user");
  if (!user) throw unauthorized("Authentication required");
  if (c.get("endUser")) {
    throw unauthorized("End-user cannot pin a member-level sticky profile");
  }
  const applicationId = c.get("applicationId")!;
  const body = await c.req.json().catch(() => ({}));
  const { connectionProfileId } = parseBody(setProfileSchema, body);
  await setMemberApplicationProfileId(user.id, applicationId, connectionProfileId);
  return c.json({ connectionProfileId });
});

router.delete("/application-profile", requireAppContext(), async (c) => {
  const user = c.get("user");
  if (!user) throw unauthorized("Authentication required");
  if (c.get("endUser")) {
    throw unauthorized("End-user cannot clear a member-level sticky profile");
  }
  const applicationId = c.get("applicationId")!;
  await clearMemberApplicationProfile(user.id, applicationId);
  return c.body(null, 204);
});

export default router;
