// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import { getPackage, getPackageForRead } from "../services/package-catalog.ts";
import { isInlineShadowPackageId } from "../services/inline-run.ts";
import {
  agentExecutionBlock,
  assertPackageMutationAccess,
  isInlineShadowRunReadable,
} from "../lib/package-access.ts";
import { ACTIVE_IN_SPACES_HINT } from "@appstrate/core/mcp-spaces";
import { canReadRuns, reportPermissionDenial } from "@appstrate/core/permissions";
import { callerPermissions } from "../lib/permissions.ts";
import { ApiError, forbidden, invalidRequest } from "../lib/errors.ts";
import { unnameableSpace } from "../lib/reachable-spaces.ts";
import { otherSpacesHolding, type LaunchSpace } from "../lib/launch-spaces.ts";
import { runVisibilityFilter } from "../lib/run-visibility.ts";
import { credentialAdmitsSpace } from "../lib/view-as.ts";
import { hasHandlerMarker, markHandler } from "./handler-marker.ts";
import { PERMISSION_GUARD } from "./require-permission.ts";

/** Stamped on middleware that resolves an agent and 404s on an unreachable one.
 *  Mounting it ahead of the permission guard turns 403-vs-404 into a catalog
 *  oracle; a conformance test reads the real order off the route table. */
const AGENT_LOOKUP = Symbol.for("appstrate.agentLookup");

/** Stamped on {@link requireActiveAgent}, so a conformance test can read off
 *  the route table WHICH routes ask the activation question — the list is the
 *  contract, and it is three. */
const ACTIVE_AGENT_GATE = Symbol.for("appstrate.activeAgentGate");

/** True when `handler` is a middleware produced by {@link requireAgent} or
 *  {@link requireAgentOrInlineRun} — i.e. it can 404 on an unreachable agent. */
export function isAgentLookup(handler: unknown): boolean {
  return hasHandlerMarker(handler, AGENT_LOOKUP);
}

/** True when `handler` is a middleware produced by {@link requireActiveAgent}. */
export function isActiveAgentGate(handler: unknown): boolean {
  return hasHandlerMarker(handler, ACTIVE_AGENT_GATE);
}

/**
 * Middleware: load an agent by route param and set it on context, or 404.
 *
 * The rule is PLACEMENT — the agent is homed in this space, placed in it, or
 * shipped with the deployment ({@link getPackageForRead}) — and nothing
 * else. An agent placed here and switched OFF is loaded like any other: reading
 * an agent, listing its runs, choosing its model and asking what is blocking it
 * are the acts of somebody about to switch it back on, and a guard that hid the
 * agent from them would break the very page that carries the switch.
 *
 * `agent_not_found` is therefore the ONLY refusal this middleware raises, and
 * it is 404 rather than 403 on purpose: a space that holds no placement learns
 * nothing about the agent from it.
 *
 * Whether the agent may RUN is a second, narrower question, and the three doors
 * that ask it mount {@link requireActiveAgent} behind this one.
 */
export function requireAgent() {
  return markHandler(async (c: Context<AppEnv>, next: Next) => {
    const packageId = `${c.req.param("scope")}/${c.req.param("name")}`;
    const agent = await getPackageForRead(packageId, c.get("orgId"), c.get("spaceId"));
    if (!agent) throw agentNotFound(packageId);
    c.set("package", agent);
    return next();
  }, AGENT_LOOKUP);
}

/** The shadow of a run the caller may read: `GET /api/runs/:id`'s rule — the
 *  runs permission, then ownership — or `null`. */
async function loadReadableShadow(c: Context<AppEnv>, packageId: string) {
  if (!canReadRuns((p) => callerPermissions(c).has(p))) return null;
  const orgId = c.get("orgId");
  if (
    !(await isInlineShadowRunReadable(orgId, c.get("spaceId"), packageId, runVisibilityFilter(c)))
  )
    return null;
  return getPackage(packageId, orgId, { includeEphemeral: true });
}

/**
 * Middleware: {@link requireAgent}, widened to an inline run's shadow
 * (`@inline/r-<uuid>`) when the caller may read a run of it in this space
 * ({@link isInlineShadowRunReadable}, under the run read rule). The shadow is
 * never placed, yet its run files `note` / `pin` rows under its id. Mounted on
 * ONE route: the persistence read of the run page.
 */
export function requireAgentOrInlineRun() {
  return markHandler(async (c: Context<AppEnv>, next: Next) => {
    const packageId = `${c.req.param("scope")}/${c.req.param("name")}`;
    const orgId = c.get("orgId");
    const spaceId = c.get("spaceId");

    // An `@inline/` id is a shadow and nothing else: no organization package can
    // be created under a reserved scope (`assertPackageScopeNotReserved`), so
    // there is no placed `@inline/` agent to fall back to.
    const agent = isInlineShadowPackageId(packageId)
      ? await loadReadableShadow(c, packageId)
      : await getPackageForRead(packageId, orgId, spaceId);
    if (!agent) throw agentNotFound(packageId);
    c.set("package", agent);
    return next();
  }, AGENT_LOOKUP);
}

/**
 * Middleware: refuse an agent that may not EXECUTE here.
 *
 * Mounted behind {@link requireAgent} by the three doors that make an agent
 * run — `POST …/run` (a rerun included, it is the same route), `POST
 * …/schedules` and `GET …/bundle` — and by nothing else. "Switched off" is a
 * statement about EXECUTION (RBAC spec §6.9); attaching it to the reads would
 * answer the execution question to callers who only asked what the agent is.
 *
 * The question itself is {@link agentExecutionBlock} — placed here AND active
 * here, the one predicate the scheduler tick asks too, so a cron and a button
 * press cannot disagree about what runs.
 *
 * `404 agent_not_active_in_space`, and the detail names both the space and the
 * one call that fixes it: the caller can already SEE this agent, so an opaque
 * "not found" would send the CLI and the SPA hunting for a typo. An agent they
 * cannot see never reaches here — {@link requireAgent} answered
 * `agent_not_found` first — so the distinction leaks nothing.
 *
 * Readiness (`GET …/connection-readiness`) deliberately does NOT mount this: it
 * REPORTS what blocks a run, so inactivity belongs in its payload as a blocking
 * error, and a 404 would blank the panel that explains the refusal.
 *
 * The refusing route supplies the alternative spaces for its own request.
 */
export function requireActiveAgent(alternatives: (c: Context<AppEnv>) => Promise<LaunchSpace[]>) {
  return markHandler(async (c: Context<AppEnv>, next: Next) => {
    const agent = c.get("package");
    const orgId = c.get("orgId");
    const spaceId = c.get("spaceId");
    const block = await agentExecutionBlock({ orgId, spaceId }, agent.id);
    // `not_placed` behind {@link requireAgent} means the placement was revoked
    // between the two reads, so the opaque refusal is the honest one: the
    // caller has just lost sight of this agent, and the named one would report
    // a state they are no longer entitled to observe.
    if (block === "not_placed") throw agentNotFound(agent.id);
    if (block === "not_active") {
      // The activation refusal precedes body, version and draft-authority checks. A
      // selection the route cannot honor gives no alternatives and keeps the original 404.
      const activeInSpaces = await alternatives(c).catch((err: unknown) => {
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) return [];
        throw err;
      });
      throw agentNotActiveInSpace(agent.id, spaceId, activeInSpaces);
    }
    return next();
  }, ACTIVE_AGENT_GATE);
}

/**
 * The inline-run doors compose an agent on the fly (`canComposeInline`: `agents:write` and
 * `agents:run`). A caller who cannot here is told so, and which of their other spaces would let
 * them (`active_in_spaces`), instead of a bare `forbidden`. Mounted in front of the per-grant
 * `requirePermission` guards, which stay the enforcement; the alternatives are computed on refusal only.
 */
export function requireInlineCompose() {
  return async (c: Context<AppEnv>, next: Next) => {
    await assertCanComposeInline(c);
    return next();
  };
}

/**
 * The composing rule, once: throws the inline refusal (reporting the missing permission) when the
 * caller lacks `agents:write` or `agents:run` in this space. Shared by {@link requireInlineCompose}
 * and the `/runs/remote` inline branch.
 */
export async function assertCanComposeInline(c: Context<AppEnv>): Promise<void> {
  const held = c.get("permissions");
  const missing = (["agents:write", "agents:run"] as const).find((p) => !held?.has(p));
  if (missing) {
    reportPermissionDenial(c, missing);
    throw await inlineRunNotAllowedInSpace(c);
  }
}

/**
 * `POST /runs/remote` carries inline vs registry in its body (`source.kind`). Mounted in front of
 * the route's `requirePermission("agents","run")`, this gives an inline source the same refusal as
 * the other inline doors when the caller cannot compose; a registry source, a body that does not
 * parse, or a caller who can compose falls through untouched (the route guard and the body
 * validation keep their own answers).
 */
export function requireInlineComposeForInlineSource() {
  return async (c: Context<AppEnv>, next: Next) => {
    const held = c.get("permissions");
    if (held?.has("agents:write") && held?.has("agents:run")) return next();
    let kind: unknown;
    try {
      const body: unknown = await c.req.json();
      kind = (body as { source?: { kind?: unknown } } | null)?.source?.kind;
    } catch {
      return next();
    }
    if (kind === "inline") await assertCanComposeInline(c);
    return next();
  };
}

/** The refusal of an inline run by a caller who cannot compose in this space. */
async function inlineRunNotAllowedInSpace(c: Context<AppEnv>): Promise<ApiError> {
  const spaceId = c.get("spaceId");
  const activeInSpaces = await otherSpacesHolding(c, ["agents:write", "agents:run"]);
  return new ApiError({
    status: 403,
    code: "inline_run_not_allowed_in_space",
    title: "Inline Run Not Allowed",
    detail:
      `Your role in space '${spaceId}' does not allow composing an inline run` +
      (activeInSpaces.length > 0 ? ACTIVE_IN_SPACES_HINT : "."),
    extensions: { active_in_spaces: activeInSpaces },
  });
}

/** An agent the caller can see but not run here: activate it here or, with consent, use `activeInSpaces`. */
function agentNotActiveInSpace(packageId: string, spaceId: string, activeInSpaces: LaunchSpace[]) {
  return new ApiError({
    status: 404,
    code: "agent_not_active_in_space",
    title: "Agent Not Active",
    detail:
      `Agent '${packageId}' is placed in space '${spaceId}' but not active there. ` +
      `Activate it with POST /api/spaces/${spaceId}/packages {"packageId":"${packageId}"}` +
      (activeInSpaces.length > 0 ? ACTIVE_IN_SPACES_HINT : "."),
    extensions: { active_in_spaces: activeInSpaces },
  });
}

/** The opaque refusal: this caller may not know the agent exists here. */
export function agentNotFound(packageId: string) {
  return new ApiError({
    status: 404,
    code: "agent_not_found",
    title: "Agent Not Found",
    detail: `Agent '${packageId}' not found`,
  });
}

/** Extract the package ID from route params (scoped `@scope/name` or unscoped `id`). */
function extractPackageId(c: Context<AppEnv>): string {
  const scope = c.req.param("scope");
  const name = c.req.param("name");
  const id = c.req.param("id");
  // Route pattern `:scope{@[^/]+}` includes the @ prefix
  const packageId = scope && name ? `${scope}/${name}` : id;
  if (!packageId) {
    throw invalidRequest("Package ID is required");
  }
  return packageId;
}

/**
 * Package ownership plus mutation authority in the package's HOME space —
 * `packages.home_space_id`, the one authority over a draft, its versions and its
 * identity, whatever other spaces it is placed in (RBAC spec §6.9). There is no
 * second authority beside it: an organization's package ALWAYS has a home
 * (`packages_org_package_has_home`), the organization's default space homing the
 * ones that belong to no team — `assertPackageMutationAccess`
 * (`lib/package-access.ts`) states the rule in full. This is the whole
 * authorization for a mutation of an existing package; routes carrying it
 * deliberately have no second permission guard against the current space.
 */
export function requirePackageInOrg(action: "write" | "delete" = "write") {
  return markHandler(async (c: Context<AppEnv>, next: Next) => {
    const packageId = extractPackageId(c);
    await assertPackageMutationAccess(c, packageId, action);
    return next();
  }, PERMISSION_GUARD);
}

/** Middleware: for API key callers, reject with 403 when the `:orgId` route
 *  param does not match the key's bound org. Sessions are passed through
 *  unchanged — they legitimately see every org they belong to.
 *
 *  Why: an API key carries an `orgId` scope, while a `/api/orgs/*` handler
 *  that resolves membership from the creator's `user.id` would let a key
 *  issued in org A read/mutate other orgs the creator is a member of. Pin every `:orgId` route to the key's bound org. */
export async function apiKeyOrgScopeGuard(c: Context<AppEnv>, next: Next) {
  if (c.get("authMethod") !== "api_key") return next();
  const paramOrgId = c.req.param("orgId");
  if (paramOrgId && paramOrgId !== c.get("orgId")) {
    throw forbidden("API key scope does not include this organization");
  }
  return next();
}

/** Middleware: reject when the `:id` route param names a space the
 *  credential may not name (`credentialAdmitsSpace`): outside the space it pins
 *  (403, the contract of a pinned key), or outside its allowlist (404, as
 *  `enterSpaceById`; see `unnameableSpace`). A credential with neither (a session, an OIDC
 *  instance token) passes, subject to the per-space permission gates.
 *
 *  Why: `/api/spaces` is org-scoped, not space-scoped, so `requireSpaceContext`
 *  never runs on it, and its org-permission routes (detail, delete, convert,
 *  sweep) never enter the path space. Keyed on the credential's confinement, NOT
 *  on `authMethod === "api_key"`: an OIDC end-user token pins a space too and
 *  carries no `orgRole`, so nothing downstream compares the path space to its
 *  pin (RBAC spec §7.2). Every confined kind is refused here, once. */
export async function pinnedSpaceScopeGuard(c: Context<AppEnv>, next: Next) {
  const paramSpaceId = c.req.param("id");
  if (paramSpaceId && !credentialAdmitsSpace(c, paramSpaceId)) {
    throw unnameableSpace(c, paramSpaceId);
  }
  return next();
}
