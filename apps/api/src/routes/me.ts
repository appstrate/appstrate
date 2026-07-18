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
 *     (`/api/me/orgs` is the prerequisite to setting it; org-scoped reads
 *     use the org already pinned by the strategy or `X-Org-Id`; the pin and
 *     context routes below opt back into app context via `requireAppContext`),
 *   - accept every auth method that represents a single user (cookie session,
 *     API key, OAuth2 instance/dashboard/end-user JWTs),
 *   - return only the data the caller is entitled to (API key sees its
 *     bound org, OIDC end-user sees their application's owning org,
 *     dashboard user sees every org they're a member of); write/delete
 *     routes additionally enforce per-row owner (`userId`/`endUserId`)
 *     scoping in the service layer, not org membership.
 *
 * Surface (each an explicitly named route — this namespace is NOT a
 * catch-all user-profile endpoint; adding a capability means adding a
 * named route here):
 *   - GET    /orgs                      — orgs the caller belongs to
 *   - GET    /models                    — models available in the active org
 *   - GET    /connections               — the caller's integration connections
 *   - DELETE /connections/:connectionId — destructive global credential delete
 *   - GET    /integration-pins          — member-self pins for an agent
 *   - PUT    /integration-pins          — upsert a member-self pin
 *   - DELETE /integration-pins          — clear a member-self pin
 *   - GET    /context                   — the caller's working context (get_me)
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { getOrgById, getUserOrganizations } from "../services/organizations.ts";
import { listOrgModels } from "../services/org-models.ts";
import { db } from "@appstrate/db/client";
import { integrationConnections } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { listMeConnections, type MeConnectionAuthority } from "../services/me-connections.ts";
import { getActor } from "../lib/actor.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { requireAppContext } from "../middleware/app-context.ts";
import { getAppScope, type ActorScope, type AppScope } from "../lib/scope.ts";
import {
  upsertMemberPin,
  deleteMemberPin,
  listMemberPinsForAgent,
} from "../services/integration-pins-service.ts";
import {
  deleteIntegrationConnection,
  listUsableIntegrationsForActor,
} from "../services/integration-connections.ts";
import { listRunnableAgents, listInstalledSkills } from "../services/application-packages.ts";
import { listRecentForActor } from "../services/state/runs.ts";
import { getEndUser } from "../services/end-users.ts";
import { recordAuditFromContext } from "../services/audit.ts";
import { unauthorized, invalidRequest } from "../lib/errors.ts";
import { readJsonBody } from "../lib/request-body.ts";
import { listResponse } from "../lib/list-response.ts";

const router = new Hono<AppEnv>();

/**
 * Derive the authority boundary of the presented credential for the
 * `/me/connections` surface (list + delete).
 *
 * An API key authenticates as its CREATOR (`c.get("user")` is the key's
 * creator), but the key itself is bound to one org + one application and its
 * bearer is a long-lived secret that may be handed to a third-party
 * application. The cross-org/cross-app view is an interactive-dashboard
 * feature — it must never be reachable with an API key, or a leaked key
 * could enumerate (and destructively delete) the creator's connections in
 * every org they belong to. The API-key auth branch always pins both ids
 * on the context; their absence under `api_key` is an auth-pipeline bug,
 * so fail closed rather than fall back to the global view.
 */
function getMeConnectionAuthority(c: Context<AppEnv>): MeConnectionAuthority {
  if (c.get("authMethod") !== "api_key") return { kind: "user_global" };
  const orgId = c.get("orgId");
  const applicationId = c.get("applicationId");
  if (!orgId || !applicationId) {
    throw unauthorized("API key is missing its org/application binding");
  }
  return { kind: "app_scoped", orgId, applicationId };
}

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
 * GET /api/me/connections — unified user-scope connection list.
 *
 * For interactive user credentials (cookie session, OAuth dashboard/instance
 * JWT): every integration connection the caller owns across all orgs/apps
 * they're a member of — the connection list belongs to the user, not to any
 * org/application, so org context is skipped entirely.
 *
 * For an API key: hard-scoped to the key's bound (org, application) pair —
 * the key authenticates as its creator, but its bearer must not be able to
 * enumerate the creator's connections in other orgs/apps
 * (see {@link getMeConnectionAuthority}). Source-grouped (one group per
 * package) in both cases.
 */
router.get("/connections", async (c) => {
  const actor = getActor(c);
  const authority = getMeConnectionAuthority(c);
  const groups = await listMeConnections(actor, authority);
  return c.json(listResponse(groups));
});

/**
 * `/api/me/integration-pins` — member-self pin CRUD.
 *
 * The persisted replacement for the R5 localStorage pick: when an agent
 * has >1 candidate connection on a required (integration, authKey) and
 * the member picks one, the choice is stored here and read by the
 * resolver on every subsequent run (cascade layer 4).
 *
 * Member-only (no end-user surface — end-users are addressed via API key
 * impersonation and the calling member controls the choice via run
 * overrides). All routes require `X-Application-Id`; the pin is scoped
 * to (member, application, agent, integration, authKey).
 *
 * Admin pins live under `/api/integrations/:packageId/pins/...` and use
 * a different validation rule (the connection must be `sharedWithOrg`);
 * the two sets coexist in the same table, discriminated by `user_id`.
 */
const upsertMemberPinSchema = z.object({
  agent_package_id: z.string().min(1),
  integration_package_id: z.string().min(1),
  connection_id: z.uuid(),
});

router.get("/integration-pins", requireAppContext(), async (c) => {
  const user = c.get("user");
  if (!user) throw unauthorized("Authentication required");
  if (c.get("endUser")) {
    // End-users have no member-pin surface — return an empty list rather
    // than 403 so the picker can render without special-casing the actor.
    return c.json(listResponse([]));
  }
  const agentPackageId = c.req.query("agent_package_id");
  if (!agentPackageId) {
    return c.json(listResponse([]));
  }
  const scope = getAppScope(c);
  const pins = await listMemberPinsForAgent(scope, agentPackageId, user.id);
  return c.json(listResponse(pins));
});

router.put("/integration-pins", requireAppContext(), async (c) => {
  const user = c.get("user");
  if (!user) throw unauthorized("Authentication required");
  if (c.get("endUser")) {
    throw unauthorized("End-user cannot set a member-scope pin");
  }
  const scope = getAppScope(c);
  const input = await readJsonBody(c, upsertMemberPinSchema, { allowEmpty: true });
  const result = await upsertMemberPin(scope, {
    agentPackageId: input.agent_package_id,
    integrationId: input.integration_package_id,
    connectionId: input.connection_id,
    userId: user.id,
  });
  await recordAuditFromContext(c, {
    action: "integration.member_pin.upserted",
    resourceType: "integration_pin",
    resourceId: `${input.agent_package_id}|${input.integration_package_id}`,
    after: { connectionId: input.connection_id },
  });
  return c.json(result);
});

router.delete("/integration-pins", requireAppContext(), async (c) => {
  const user = c.get("user");
  if (!user) throw unauthorized("Authentication required");
  if (c.get("endUser")) {
    throw unauthorized("End-user cannot clear a member-scope pin");
  }
  const scope = getAppScope(c);
  const agentPackageId = c.req.query("agent_package_id");
  const integrationId = c.req.query("integration_package_id");
  if (!agentPackageId || !integrationId) {
    throw invalidRequest("agent_package_id and integration_package_id query params are required");
  }
  const result = await deleteMemberPin(scope, agentPackageId, integrationId, user.id);
  if (result.deleted) {
    await recordAuditFromContext(c, {
      action: "integration.member_pin.deleted",
      resourceType: "integration_pin",
      resourceId: `${agentPackageId}|${integrationId}`,
    });
  }
  return c.body(null, 204);
});

/**
 * `DELETE /api/me/connections/:connectionId` — destructive global delete.
 *
 * Removes the underlying `integration_connections` row. ON DELETE CASCADE
 * naturally vacates every reference: admin pins, member pins, run snapshots,
 * schedule overrides. The intent is *destructive* — "I never want to use
 * this credential anywhere again".
 *
 * The previous user-facing entrypoint on the agent surface
 * (`DELETE /api/integrations/:packageId/connections/:connectionId`) was
 * removed in favour of this single owner-scoped endpoint. Surfaced
 * only from `/connections` (the user-owned management page) so members
 * can't accidentally trigger a global delete from an agent context.
 *
 * App context is implicit — the connection row carries `application_id`,
 * we re-derive scope from it instead of asking the SPA to send a header
 * for a per-row operation. EXCEPT for API-key callers: the key is bound to
 * one (org, application) and a delete outside that boundary is refused (a
 * leaked key must not be able to destroy the creator's credentials in other
 * orgs/apps), so the key's own scope is used instead of the row-derived one.
 */
router.delete("/connections/:connectionId", async (c) => {
  const connectionId = c.req.param("connectionId")!;
  const actor = getActor(c);
  const authority = getMeConnectionAuthority(c);

  // The id hits a `uuid` column — a non-UUID would raise PG `22P02` and surface
  // as a 500. Validate first and short-circuit to 204: same non-disclosure
  // intent as the "row not found" branch below (no information leak to a caller
  // probing ids).
  if (!z.uuid().safeParse(connectionId).success) {
    return c.body(null, 204);
  }

  // /me/* skips org/app context middleware — derive applicationId from
  // the connection row itself. Ownership is enforced by the service via
  // (userId | endUserId) filter, not by org membership: a connection
  // belongs to its owner regardless of which org context they're browsing.
  const [row] = await db
    .select({ applicationId: integrationConnections.applicationId })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
    .limit(1);
  if (!row) {
    // 204 instead of 404 keeps the response stable whether the connection
    // never existed or already deleted — same end state, no information
    // disclosure to a caller probing IDs.
    return c.body(null, 204);
  }

  // Scope selection depends on the credential's authority:
  //
  //   - API key (`app_scoped`): the key is bound to one (org, application).
  //     A connection outside that application short-circuits to 204 (same
  //     non-disclosure as the "row not found" branch — a probing key learns
  //     nothing), and the delete itself runs under the KEY'S `AppScope`, so
  //     the service's app∈org assertion and its `applicationId` WHERE filter
  //     both enforce the boundary in SQL.
  //
  //   - Interactive user credential (`user_global`): pass an `ActorScope`
  //     (applicationId only, no orgId) deliberately. `/me/connections` is an
  //     actor-ownership boundary, not an app∈org one: a connection belongs to
  //     its owner regardless of which org the caller is currently scoped to.
  //     The absence of `orgId` tells the service to skip its app∈org
  //     assertion and rely solely on the (userId | endUserId) ownership
  //     predicate. Passing the caller's live `c.get("orgId")` here (populated
  //     for OIDC callers, empty for cookie sessions) would wrongly run that
  //     assertion and 404 a self-owned connection whose application lives in
  //     a different org. Ownership is still fully enforced downstream by the
  //     actor filter.
  let scope: AppScope | ActorScope;
  if (authority.kind === "app_scoped") {
    if (row.applicationId !== authority.applicationId) {
      return c.body(null, 204);
    }
    scope = { orgId: authority.orgId, applicationId: authority.applicationId };
  } else {
    scope = { applicationId: row.applicationId } satisfies ActorScope;
  }
  await deleteIntegrationConnection(scope, connectionId, actor);
  await recordAuditFromContext(c, {
    action: "integration.connection.deleted",
    resourceType: "integration_connection",
    resourceId: connectionId,
  });
  return c.body(null, 204);
});

/**
 * GET /api/me/context — the caller's working context for an AI agent.
 *
 * One payload, three consumers: the chat module injects it into the system
 * prompt, the platform MCP server exposes it as the `get_me` tool, and
 * external REST/MCP clients call it directly. Returns the caller's identity,
 * their role in the pinned org, and the integrations they could attach when
 * building an agent in the current application (own or org-shared) — so the
 * agent can prefer already-connected integrations and respect the caller's
 * role (operations beyond it will 403 at invoke time).
 *
 * App context resolves from `X-Application-Id`, the API key's application, or
 * (for the in-process MCP sub-dispatch) the org's default application.
 */
router.get("/context", requireAppContext(), async (c) => {
  const actor = getActor(c);
  const scope = getAppScope(c);

  let identity: { id: string; name: string | null; email: string | null };
  if (actor.type === "end_user") {
    const eu = await getEndUser(scope, actor.id);
    identity = { id: eu.id, name: eu.name ?? null, email: eu.email ?? null };
  } else {
    const user = c.get("user");
    if (!user) throw unauthorized("Authentication required");
    identity = { id: user.id, name: user.name ?? null, email: user.email ?? null };
  }

  const role = (c.get("orgRole") as string | undefined) ?? "end_user";

  // Agents are a runnable-hint: only surface them when the caller actually holds
  // `agents:run` (otherwise the model would propose agents that 403 at invoke).
  // The list is app-scoped (same for every actor in the app), capped for prompt
  // size, and authoritative execution still re-checks RBAC at the run route.
  // Skills, like agents, are only useful for building/configuring an agent run,
  // so they share the `agents:run` gate. They aren't run directly — the model
  // declares them under an agent manifest's `dependencies.skills`.
  const canRun = (c.get("permissions") as Set<string> | undefined)?.has("agents:run") ?? false;
  const [connections, runnable, installedSkills, recentRuns] = await Promise.all([
    listUsableIntegrationsForActor(scope, actor),
    canRun
      ? listRunnableAgents(scope)
      : Promise.resolve({ agents: [], truncated: false, total: 0 }),
    canRun
      ? listInstalledSkills(scope)
      : Promise.resolve({ skills: [], truncated: false, total: 0 }),
    // The caller's own recent runs (actor-scoped) — no extra permission needed.
    listRecentForActor(scope, actor),
  ]);

  return c.json({
    user: identity,
    org: {
      id: scope.orgId,
      role,
      name: (c.get("orgName") as string | undefined) ?? null,
      slug: (c.get("orgSlug") as string | undefined) ?? null,
    },
    connections,
    recent_runs: recentRuns,
    agents: runnable.agents,
    agents_truncated: runnable.truncated,
    agents_total: runnable.total,
    skills: installedSkills.skills,
    skills_truncated: installedSkills.truncated,
    skills_total: installedSkills.total,
  });
});

export default router;
