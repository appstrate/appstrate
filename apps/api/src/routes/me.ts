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
 *     context routes below opt back into space context via `requireSpaceContext`),
 *   - accept every auth method that represents a single user (cookie session,
 *     API key, OAuth2 instance/dashboard/end-user JWTs),
 *   - return only the data the caller is entitled to (API key sees its
 *     bound org, OIDC end-user sees their space's owning org,
 *     dashboard user sees every org they're a member of); write/delete
 *     routes additionally enforce per-row owner (`userId`/`endUserId`)
 *     scoping in the service layer, not org membership.
 *
 * Surface (each an explicitly named route — this namespace is NOT a
 * catch-all user-profile endpoint; adding a capability means adding a
 * named route here):
 *   - GET    /orgs                      — orgs the caller belongs to
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
import { db } from "@appstrate/db/client";
import { integrationConnections, spaces } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { listMeConnections, type MeConnectionAuthority } from "../services/me-connections.ts";
import { getActor } from "../lib/actor.ts";
import { listedOrgIdentityForCaller } from "../lib/principal-permissions.ts";
import { callerOrgRole, resolveListingViewAs } from "../lib/view-as.ts";
import { callerPermissions } from "../lib/permissions.ts";
import { isUserPrincipal } from "../lib/principal.ts";
import { requireSpaceContext } from "../middleware/space-context.ts";
import { getSpaceScope, type ActorScope, type SpaceScope } from "../lib/scope.ts";
import {
  upsertMemberPin,
  deleteMemberPin,
  listMemberPinsForAgent,
} from "../services/integration-pins-service.ts";
import {
  deleteIntegrationConnection,
  getIntegrationConnectionCredentialFields,
  listUsableIntegrationsForActor,
  readIntegrationAuth,
} from "../services/integration-connections.ts";
import { handoffStepsFor } from "../services/connect/provisioning.ts";
import { logger } from "../lib/logger.ts";
import { listRunnableAgents, listActiveSkills } from "../services/space-packages.ts";
import { homeWireForCaller, packageAccessSpaces } from "../lib/package-access.ts";
import { listRecentForActor } from "../services/state/runs.ts";
import { canReadRuns } from "../lib/run-visibility.ts";
import { getEndUser } from "../services/end-users.ts";
import { recordAuditFromContext } from "../services/audit.ts";
import { unauthorized, invalidRequest } from "../lib/errors.ts";
import { readJsonBody } from "@appstrate/core/request-body";
import { listResponse } from "../lib/list-response.ts";

const router = new Hono<AppEnv>();

/**
 * Derive the authority boundary of the presented credential for the
 * `/me/connections` surface (list + delete).
 *
 * `user_global` is the `user` principal — the person themselves, by any
 * transport. Every other kind is `bound`: an API key (org + space), a
 * third-party OAuth client (org only), an end-user token (org + space). Each
 * authenticates as its issuer, but its bearer is a credential that may be held
 * by somebody else, so the cross-org dashboard view must never be reachable
 * with one — a leaked key could otherwise enumerate (and destructively delete)
 * the creator's connections in every org they belong to. On `main` an end-user
 * token took the global view. The org id is always pinned for a bound
 * credential; its absence is an auth-pipeline bug, so fail closed.
 */
function getMeConnectionAuthority(c: Context<AppEnv>): MeConnectionAuthority {
  if (isUserPrincipal(c)) return { kind: "user_global" };
  const orgId = c.get("orgId");
  if (!orgId) throw unauthorized("Credential is missing its organization binding");
  return { kind: "bound", orgId, spaceId: c.get("spaceId") };
}

/**
 * GET /api/me/orgs — list orgs the authenticated caller belongs to.
 *
 * - Cookie session / OIDC dashboard JWT: every org the BA user is a member of
 * - API key: the single org the key is bound to (DB-level filter — a
 *   compromised key cannot enumerate every org the creator belongs to)
 * - OIDC end-user JWT: the single org owning the impersonated end-user's
 *   space (end-users are not org members; the org is derived from
 *   `endUser.spaceId`)
 *
 * Skips `requireOrgContext` (no `X-Org-Id` required — listing orgs is the
 * prerequisite to setting it). Authentication itself is enforced by the
 * shared auth pipeline before this handler runs.
 */
router.get("/orgs", async (c) => {
  const endUser = c.get("endUser");
  if (endUser) {
    // End-users are not in `organization_members` — the OIDC strategy already
    // pinned their space's owning org on `c.set("orgId", ...)`. Reuse
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

  // A delegate is bound to a single org — filter at the DB level so a
  // compromised key cannot enumerate every org the creator belongs to. No
  // binding is an auth-pipeline bug, and the unfiltered listing is the very
  // enumeration above: fail closed. Same rule as `GET /api/orgs` keeps the two
  // paths in lockstep.
  const orgId = c.get("orgId");
  if (!isUserPrincipal(c) && !orgId) {
    throw unauthorized("Credential is missing its organization binding");
  }
  const orgIdFilter = isUserPrincipal(c) ? undefined : orgId;
  const orgs = await getUserOrganizations(user.id, orgIdFilter);
  // Once for the listing: the persona names one org, and one this listing
  // cannot place is refused rather than ignored.
  await resolveListingViewAs(c, orgs);

  return c.json(
    listResponse(
      await Promise.all(
        orgs.map(async (o) => {
          // Role and org-level effective set in THAT org, ceiling-applied — same
          // fields and same helper as `GET /api/orgs` (RBAC spec §6.5). Absent
          // from the end-user branch above: an end-user holds no org role.
          const identity = await listedOrgIdentityForCaller(c, o.id, o.role);
          return {
            id: o.id,
            name: o.name,
            slug: o.slug,
            role: identity.role,
            permissions: identity.permissions,
            createdAt: o.createdAt,
          };
        }),
      ),
    ),
  );
});

/**
 * GET /api/me/connections — unified user-scope connection list.
 *
 * For interactive user credentials (cookie session, OAuth dashboard/instance
 * JWT): every integration connection the caller owns across all orgs/spaces
 * they're a member of — the connection list belongs to the user, not to any
 * org/space, so org context is skipped entirely.
 *
 * For every other kind: hard-scoped to its binding — its org, and its space
 * when it pins one. Such a credential authenticates as its issuer, but its
 * bearer must not be able to enumerate the issuer's connections elsewhere
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
 * overrides). All routes require `X-Space-Id`; the pin is scoped
 * to (member, space, agent, integration, authKey).
 *
 * Admin pins live under `/api/integrations/:packageId/pins/...` and use
 * a different validation rule (the connection must be `sharedWithOrg`);
 * the two sets coexist in the same table, discriminated by `user_id`.
 */
export const upsertMemberPinSchema = z
  .object({
    agent_package_id: z.string().min(1),
    integration_package_id: z.string().min(1),
    connection_id: z.uuid(),
  })
  .strict();

router.get("/integration-pins", requireSpaceContext(), async (c) => {
  const user = c.get("user");
  if (!user) throw unauthorized("Authentication required");
  if (c.get("endUser")) {
    // End-users have no member-pin surface — return an empty list rather
    // than 403 so the picker can render without special-casing the actor.
    return c.json(listResponse([]));
  }
  const agentPackageId = c.req.query("agent_package_id");
  // An omitted parameter is an empty list, not a 400 — the picker renders
  // before it has an agent to ask about, exactly as it does for an end-user
  // above. The DELETE below refuses instead, because deleting nothing in
  // particular is not a coherent request. The spec is what was wrong here:
  // it marked the parameter `required` and documented a 400 this route has
  // never raised.
  if (!agentPackageId) return c.json(listResponse([]));
  const scope = getSpaceScope(c);
  const pins = await listMemberPinsForAgent(scope, agentPackageId, user.id);
  return c.json(listResponse(pins));
});

router.put("/integration-pins", requireSpaceContext(), async (c) => {
  const user = c.get("user");
  if (!user) throw unauthorized("Authentication required");
  if (c.get("endUser")) {
    throw unauthorized("End-user cannot set a member-scope pin");
  }
  const scope = getSpaceScope(c);
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

router.delete("/integration-pins", requireSpaceContext(), async (c) => {
  const user = c.get("user");
  if (!user) throw unauthorized("Authentication required");
  if (c.get("endUser")) {
    throw unauthorized("End-user cannot clear a member-scope pin");
  }
  const scope = getSpaceScope(c);
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
 * This is the ONLY entrypoint for that delete, and it is owner-scoped by
 * construction. Surfaced only from `/connections` (the user-owned management
 * page), so a member can't trigger a global delete from an agent context —
 * there they switch the agent's pick with `PUT /api/me/integration-pins`,
 * which stops one agent using a connection without destroying it.
 *
 * Space context is implicit — the connection row carries `space_id`,
 * we re-derive scope from it instead of asking the SPA to send a header
 * for a per-row operation. EXCEPT for a bound credential: a delete outside its
 * binding is refused (a leaked key must not be able to destroy the creator's
 * credentials in other orgs/spaces), so its own scope is used instead of the
 * row-derived one.
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

  // /me/* skips org/space context middleware — derive spaceId from
  // the connection row itself. Ownership is enforced by the service via
  // (userId | endUserId) filter, not by org membership: a connection
  // belongs to its owner regardless of which org context they're browsing.
  const [row] = await db
    .select({ spaceId: integrationConnections.spaceId })
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
  //   - A bound credential: when it pins a space, a connection outside that
  //     space short-circuits to 204 (same non-disclosure as the "row not
  //     found" branch — a probing key learns nothing). The delete then runs
  //     under the CREDENTIAL's `SpaceScope`, so the service's space∈org
  //     assertion and its `spaceId` WHERE filter both enforce the binding in
  //     SQL; an org-only credential is held to its org by that same assertion.
  //
  //   - A `user` principal (`user_global`): pass an `ActorScope`
  //     (spaceId only, no orgId) deliberately. `/me/connections` is an
  //     actor-ownership boundary, not a space∈org one: a connection belongs to
  //     its owner regardless of which org the caller is currently scoped to.
  //     The absence of `orgId` tells the service to skip its space∈org
  //     assertion and rely solely on the (userId | endUserId) ownership
  //     predicate. Passing the caller's live `c.get("orgId")` here (populated
  //     for OIDC callers, empty for cookie sessions) would wrongly run that
  //     assertion and 404 a self-owned connection whose space lives in
  //     a different org. Ownership is still fully enforced downstream by the
  //     actor filter.
  let scope: SpaceScope | ActorScope;
  if (authority.kind === "bound") {
    if (authority.spaceId && row.spaceId !== authority.spaceId) {
      return c.body(null, 204);
    }
    scope = { orgId: authority.orgId, spaceId: row.spaceId };
  } else {
    scope = { spaceId: row.spaceId } satisfies ActorScope;
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
 * `GET /api/me/connections/:connectionId/handoff` — what is due on the user's
 * own machine when this connection is deleted: the `deferred` steps, and only
 * those. Deleting a minted credential destroys the platform's half and nothing
 * else — its public key stays authorized on the target, which the platform
 * cannot reach — so the teardown block has to remain available afterwards.
 *
 * The install half belongs to the connect-submit response: the connect portal
 * shows it once, on the screen right after the form, and this endpoint does not
 * re-serve it.
 *
 * DERIVED on demand, never stored, by the same `handoffStepsFor` the submit
 * path calls, so the block that removes a key cannot drift from the one that
 * installed it. Computed here rather than on the connection LIST because it
 * costs a decryption, which a list must not pay per row.
 *
 * Non-disclosure matches the DELETE beside it: an unknown, malformed or
 * not-owned id answers an empty list rather than a 404, so a caller probing
 * ids learns nothing.
 */
router.get("/connections/:connectionId/handoff", async (c) => {
  const connectionId = c.req.param("connectionId")!;
  const actor = getActor(c);
  const authority = getMeConnectionAuthority(c);
  const empty = () => c.json(listResponse([]));

  if (!z.uuid().safeParse(connectionId).success) return empty();

  // `integration_connections` carries no `org_id` (it is space-scoped), and
  // reading the manifest needs one — so it comes from the space, joined here.
  const [row] = await db
    .select({
      spaceId: integrationConnections.spaceId,
      orgId: spaces.orgId,
      integrationId: integrationConnections.integrationId,
      authKey: integrationConnections.authKey,
      userId: integrationConnections.userId,
      endUserId: integrationConnections.endUserId,
    })
    .from(integrationConnections)
    .innerJoin(spaces, eq(spaces.id, integrationConnections.spaceId))
    .where(eq(integrationConnections.id, connectionId))
    .limit(1);
  if (!row) return empty();

  // Same ownership predicate the delete relies on, applied here because this
  // read decrypts a credential: a connection is its owner's regardless of the
  // org the caller is currently scoped to.
  const owns = actor.type === "end_user" ? row.endUserId === actor.id : row.userId === actor.id;
  if (!owns) return empty();
  if (authority.kind === "bound" && authority.spaceId && row.spaceId !== authority.spaceId) {
    return empty();
  }

  try {
    const { auth } = await readIntegrationAuth(
      { orgId: row.orgId, spaceId: row.spaceId },
      row.integrationId,
      row.authKey,
    );
    const credentials = await getIntegrationConnectionCredentialFields(connectionId);
    if (!credentials) return empty();
    const steps = handoffStepsFor(auth, credentials);
    return c.json(listResponse(steps.filter((s) => s.kind === "command" && s.deferred === true)));
  } catch (err) {
    // A manifest that no longer loads must not block a deletion — the user can
    // still delete, they just get no removal block.
    logger.warn("Could not derive connection handoff steps", {
      err: String(err),
      connectionId,
    });
    return empty();
  }
});

/**
 * GET /api/me/context — the caller's working context for an AI agent.
 *
 * One payload, three consumers: the chat module injects it into the system
 * prompt, the platform MCP server exposes it as the `get_me` tool, and
 * external REST/MCP clients call it directly. Returns the caller's identity,
 * their role in the pinned org, and the integrations they could attach when
 * building an agent in the current space (own or org-shared) — so the
 * agent can prefer already-connected integrations and respect the caller's
 * role (operations beyond it will 403 at invoke time).
 *
 * Space context resolves from `X-Space-Id`, the API key's space, or
 * (for the in-process MCP sub-dispatch) the org's default space.
 */
router.get("/context", requireSpaceContext(), async (c) => {
  const actor = getActor(c);
  const scope = getSpaceScope(c);

  let identity: { id: string; name: string | null; email: string | null };
  if (actor.type === "end_user") {
    const eu = await getEndUser(scope, actor.id);
    identity = { id: eu.id, name: eu.name ?? null, email: eu.email ?? null };
  } else {
    const user = c.get("user");
    if (!user) throw unauthorized("Authentication required");
    identity = { id: user.id, name: user.name ?? null, email: user.email ?? null };
  }

  // The persona's while previewing: this payload tells the model what the caller
  // may do, and every operation it names is checked against the persona.
  const role = (callerOrgRole(c) as string | undefined) ?? "end_user";

  // Agents are a runnable-hint: only surface them when the caller actually holds
  // `agents:run` (otherwise the model would propose agents that 403 at invoke).
  // The list is space-scoped (same for every actor in the space), capped for prompt
  // size, and authoritative execution still re-checks RBAC at the run route.
  // Skills are a catalog read, not a runnable hint: naming them here is the same
  // disclosure `GET /api/packages/skills` makes, so they answer to `skills:read`.
  // A runner launches what someone else composed and never learns what it is
  // composed of (RBAC spec §3.4, D-B4).
  const permissions = callerPermissions(c);
  const canRun = permissions.has("agents:run");
  const canReadSkills = permissions.has("skills:read");
  // Runs and connections are enrichments like the two above, and they carry
  // more than a hint: `recent_runs` names packages, statuses and error strings,
  // and `connections` names the accounts attached in this space. A credential
  // whose ceiling excludes `runs:read` is refused by `GET /api/runs`, so it
  // must not read the same rows through this payload either. The route itself
  // stays open — a role without runs still needs its identity and org.
  const mayReadRuns = canReadRuns(permissions);
  const mayReadIntegrations = permissions.has("integrations:read");
  // Resolved once for both hint listings: `home_writable` is what tells the
  // model whether a draft-only package is THIS caller's to run, and computing
  // it needs the caller's reach over every space, not the package rows.
  const accessible = await packageAccessSpaces(c);
  const homeWritable = (pkg: Parameters<typeof homeWireForCaller>[0]) =>
    homeWireForCaller(pkg, accessible).home_writable;
  const [connections, runnable, activeSkills, recentRuns] = await Promise.all([
    mayReadIntegrations
      ? listUsableIntegrationsForActor(scope, actor)
      : Promise.resolve([] as Awaited<ReturnType<typeof listUsableIntegrationsForActor>>),
    canRun
      ? listRunnableAgents(scope, { homeWritable })
      : Promise.resolve({ agents: [], truncated: false, total: 0 }),
    canReadSkills
      ? listActiveSkills(scope, { homeWritable })
      : Promise.resolve({ skills: [], truncated: false, total: 0 }),
    // Actor-scoped, but still a runs read: the same permission `GET /api/runs`
    // asks for (`runs:read` ∨ `runs:read-all`, `canReadRuns`).
    mayReadRuns
      ? listRecentForActor(scope, actor)
      : Promise.resolve([] as Awaited<ReturnType<typeof listRecentForActor>>),
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
    skills: activeSkills.skills,
    skills_truncated: activeSkills.truncated,
    skills_total: activeSkills.total,
  });
});

export default router;
