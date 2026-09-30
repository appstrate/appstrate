// SPDX-License-Identifier: Apache-2.0

/**
 * Integration connection resolver — the single source of truth for which SET of connections a
 * run binds to each integration. The cascade, highest precedence first:
 *
 *   1. admin pin (`integration_pins`, user_id IS NULL)   — per agent
 *   2. enforced org default (`integration_org_defaults`) — every agent of the space
 *   3. launch override — the run body's or the schedule row's `connection_overrides`
 *   4. member pin (`integration_pins`, user_id = actor)  — per agent
 *   5. soft org default
 *   6. fallback — the actor's ONE own connection on an auth serving the selection;
 *      none → `not_connected`, anything else → `must_choose_connection`
 *
 * Layers 1-5 bind their set whole or fail loudly, never falling through. A launch override
 * under layer 1 or 2 must name a subset of that governing set, which it then narrows to;
 * naming anything outside it is `override_outranked`. A shared connection is never bound
 * implicitly. `resolveConnections()` is pure; `resolveConnectionsForRun()` loads its inputs.
 */

import { and, eq, or, inArray, isNull } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  integrationConnections,
  integrationPins,
  packageShares,
  packages,
  spacePackages,
} from "@appstrate/db/schema";
import type {
  IntegrationConnectionRow as ConnectionRow,
  IntegrationPinRow as PinRow,
} from "@appstrate/db/schema";
import {
  isToolsWildcard,
  parseManifestIntegrations,
  type ManifestIntegrationEntry,
} from "@appstrate/core/dependencies";
import {
  resolveEffectiveToolSelection,
  missingScopesForConnection,
  requiredScopesForAgent,
  manifestAuthKeySet,
  manifestHasRequiredAuth,
  type IntegrationManifest,
  type ConnectionCandidate,
  type ConnectionOverrides,
  type ConnectionResolutionError,
  type ConnectionResolutionResult,
  type ConnectionResolutionSource,
  type ResolvedConnection,
  type ResolvedConnectionMap,
} from "@appstrate/core/integration";
import { ApiError, type ResolutionFieldError, type ValidationFieldError } from "../lib/errors.ts";
import type { Actor } from "../lib/actor.ts";
import { actorOrSharedFilter } from "../lib/actor.ts";
import type { SpaceScope } from "../lib/scope.ts";
import { fetchIntegrationManifest, type IntegrationManifestCache } from "./integration-service.ts";
import {
  authKeysServingSelection,
  authKeyServingNoSelectedTool,
} from "./integration-manifest-helpers.ts";
import {
  listOrgDefaultsForResolver,
  type OrgDefaultPick,
} from "./integration-org-defaults-service.ts";
import { placementReadFilter, placementShareJoin } from "./package-placement.ts";

// ─────────────────────────────────── Types ────────────────────────────────────

/** Layer 3: a run and a schedule fire never both carry one, so only `source` tells them apart. */
export interface LaunchOverrides {
  ids: ConnectionOverrides;
  source: Extract<ConnectionResolutionSource, "run_override" | "schedule_override">;
}

export function toLaunchOverrides(
  ids: ConnectionOverrides | null | undefined,
  source: LaunchOverrides["source"],
): LaunchOverrides | null {
  return ids ? { ids, source } : null;
}

export interface IntegrationRequirement {
  integrationId: string;
  manifest: IntegrationManifest;
  /** The EFFECTIVE selection (below) is non-empty or `"*"` — what the spawn resolver starts. */
  hasSelectedTools: boolean;
  /** The agent's own tool selection; drives scope inference (`"*"` → the auth's default scopes). */
  agentTools: readonly string[] | "*";
  /** The agent's explicit oauth scopes — the only scope signal of an apiCall integration. */
  agentScopes: readonly string[];
  /** An auth is marked `_meta["dev.appstrate/auth"].required`: active even with no selection. */
  hasRequiredAuth?: boolean;
  /** AFPS §4.1 `auth_key`: only rows on that auth are candidates, at every layer. */
  requiredAuthKey?: string;
  /** Effective selection (`tools[]`, else `default_tools`); absent → any auth serves it. */
  effectiveTools?: readonly string[] | "*";
}

interface ResolveConnectionsInput {
  requirements: IntegrationRequirement[];
  accessibleConnections: ConnectionRow[];
  /** Admin pins (`userId` null) and the actor's member pins for (space, agent). */
  pins: PinRow[];
  launchOverrides?: LaunchOverrides | null;
  /** Per integration; `enforce` places it at layer 2, else layer 5. */
  orgDefaults?: Record<string, OrgDefaultPick> | null;
  actorUserId?: string | null;
  actorEndUserId?: string | null;
  /** Also resolve INERT integrations (never spawned): the agent-page picker still manages them. */
  includeInert?: boolean;
}

// ─────────────────────────── Pure resolver (unit-tested) ──────────────────────

/** Walks the cascade (file header) per integration. */
export function resolveConnections(input: ResolveConnectionsInput): ConnectionResolutionResult {
  const resolved: ResolvedConnectionMap = {};
  const errors: ConnectionResolutionError[] = [];

  const actorUserId = input.actorUserId ?? null;
  const accessibleIndex = new Map(input.accessibleConnections.map((c) => [c.id, c]));
  const pinIds = (integrationId: string, userId: string | null) =>
    nonEmpty(
      input.pins.find((p) => p.integrationId === integrationId && p.userId === userId)
        ?.connectionIds,
    );

  for (const req of input.requirements) {
    // Inert: nothing the spawn resolver would start, so no verdict is needed.
    if (
      !req.hasSelectedTools &&
      req.agentScopes.length === 0 &&
      !req.hasRequiredAuth &&
      !input.includeInert
    )
      continue;

    const auth = authFilterOf(req);

    // The agent's configuration, not a connection: no connection, pin or override clears it.
    const misfit = authKeyServingNoSelectedTool(
      req.manifest,
      req.requiredAuthKey,
      req.effectiveTools,
    );
    if (misfit !== null) {
      errors.push({
        integrationId: req.integrationId,
        code: "auth_key_serves_no_selected_tool",
        requiredAuthKey: misfit.authKey,
        message: `The agent requires auth '${misfit.authKey}' for ${req.integrationId}, which exposes none of its selected tools (auths that do: ${misfit.servingAuthKeys.join(", ")}) — the agent's auth_key or its tool selection must change.`,
      });
      continue;
    }

    // Orphaned-auth guard: a row on an auth the CURRENT manifest no longer declares can never
    // produce a delivery plan, so it is no candidate at any layer.
    const live = input.accessibleConnections.filter(
      (c) =>
        c.integrationId === req.integrationId && (auth.live === null || auth.live.has(c.authKey)),
    );
    // AFPS §4.1 `auth_key`: pre-filtered so every layer honours it.
    const candidates =
      req.requiredAuthKey === undefined
        ? live
        : live.filter((c) => c.authKey === req.requiredAuthKey);
    if (req.requiredAuthKey !== undefined && candidates.length === 0 && live.length > 0) {
      // Not `not_connected`: that would hide the real cause.
      const availableAuthKeys = [...new Set(live.map((c) => c.authKey))];
      errors.push({
        integrationId: req.integrationId,
        code: "auth_key_mismatch",
        requiredAuthKey: req.requiredAuthKey,
        availableAuthKeys,
        message: `Integration '${req.integrationId}' requires auth '${req.requiredAuthKey}' but the actor's accessible connections use [${availableAuthKeys.join(", ")}].`,
      });
      continue;
    }

    const result = resolveOne({
      integrationId: req.integrationId,
      manifest: req.manifest,
      agentTools: req.agentTools,
      agentScopes: req.agentScopes,
      adminPinIds: pinIds(req.integrationId, null),
      orgDefault: input.orgDefaults?.[req.integrationId] ?? null,
      launchOverride: launchOverrideFor(input.launchOverrides, req.integrationId),
      memberPinIds: actorUserId === null ? null : pinIds(req.integrationId, actorUserId),
      candidates,
      candidateIndex: new Map(candidates.map((c) => [c.id, c])),
      accessibleIndex,
      actorUserId,
      actorEndUserId: input.actorEndUserId ?? null,
      auth,
    });

    if (result.kind === "resolved") {
      resolved[req.integrationId] = result.value;
    } else {
      errors.push(result.error);
    }
  }

  return { resolved, errors };
}

// ─────────────────────────── Per-integration core ─────────────────────────────

/** An empty set is "this layer has no opinion"; every write refuses one. */
function nonEmpty(ids: readonly string[] | null | undefined): readonly string[] | null {
  return ids && ids.length > 0 ? ids : null;
}

function launchOverrideFor(
  launch: LaunchOverrides | null | undefined,
  integrationId: string,
): ResolveOneArgs["launchOverride"] {
  const ids = nonEmpty(launch?.ids[integrationId]);
  return launch && ids ? { ids, source: launch.source } : null;
}

interface ResolveOneArgs {
  integrationId: string;
  manifest: IntegrationManifest;
  agentTools: readonly string[] | "*";
  agentScopes: readonly string[];
  adminPinIds: readonly string[] | null;
  orgDefault: OrgDefaultPick | null;
  launchOverride: { ids: readonly string[]; source: LaunchOverrides["source"] } | null;
  memberPinIds: readonly string[] | null;
  /** This integration's rows that survived the auth filters. */
  candidates: ConnectionRow[];
  candidateIndex: ReadonlyMap<string, ConnectionRow>;
  /** Before the auth filters: tells a row they dropped from one the actor cannot reach. */
  accessibleIndex: ReadonlyMap<string, ConnectionRow>;
  actorUserId: string | null;
  actorEndUserId: string | null;
  /** Already applied to the candidates; kept to name the connect target on `not_connected`. */
  auth: AuthFilter;
}

type ResolveOneResult =
  | { kind: "resolved"; value: ResolvedConnection[] }
  | { kind: "error"; error: ConnectionResolutionError };

/**
 * A layer's rows, or its first id not a candidate — a row of ANOTHER integration included, else
 * its credentials would be injected under this integration's auth.
 */
function ownedConns(
  args: ResolveOneArgs,
  ids: readonly string[],
): { rows: ConnectionRow[] } | { missingId: string; offAuthKey?: string } {
  const rows: ConnectionRow[] = [];
  for (const id of ids) {
    const conn = args.candidateIndex.get(id);
    if (!conn) {
      const dropped = args.accessibleIndex.get(id);
      return dropped?.integrationId === args.integrationId
        ? { missingId: id, offAuthKey: dropped.authKey }
        : { missingId: id };
    }
    rows.push(conn);
  }
  return { rows };
}

/** Why the auth filters dropped a reachable row: an orphaned auth, or not the dep's `auth_key`. */
function offAuthReason(auth: AuthFilter, authKey: string): string {
  return auth.live !== null && !auth.live.has(authKey)
    ? `is on auth '${authKey}', which the integration no longer declares`
    : `is on auth '${authKey}', not the auth '${auth.requiredAuthKey}' this agent requires`;
}

function bindSet(
  args: ResolveOneArgs,
  rows: ConnectionRow[],
  source: ResolvedConnection["source"],
): ResolveOneResult {
  const boundConnectionIds = rows.map((c) => c.id);
  const value: ResolvedConnection[] = [];
  for (const conn of rows) {
    const health = checkHealth(args, conn, source);
    if (health.kind === "error") {
      return { kind: "error", error: { ...health.error, boundConnectionIds } };
    }
    value.push(health.value);
  }
  return { kind: "resolved", value };
}

interface ExplicitLayerRef {
  source: ResolvedConnection["source"];
  code: "pinned_connection_unavailable" | "override_connection_unavailable";
  noun: string;
}

type ExplicitLayer<Ids = readonly string[] | null> = ExplicitLayerRef & { ids: Ids };

function orgDefaultLayer(enforce: boolean): ExplicitLayerRef {
  return {
    source: enforce ? "org_default_enforced" : "org_default",
    code: "pinned_connection_unavailable",
    noun: "Org default connection",
  };
}

export function launchOverrideLayer(source: LaunchOverrides["source"]): ExplicitLayerRef {
  return {
    source,
    code: "override_connection_unavailable",
    noun: source === "run_override" ? "Run-override connection" : "Schedule-override connection",
  };
}

export function unavailableMemberError(
  integrationId: string,
  layer: ExplicitLayerRef,
  missingId: string,
  reason?: string,
): ConnectionResolutionError {
  const deleted = " — it may have been deleted or unshared";
  const hint = layer.code === "pinned_connection_unavailable" ? deleted : "";
  return {
    integrationId,
    code: layer.code,
    source: layer.source,
    message: `${layer.noun} '${missingId}' for ${integrationId} ${reason ?? `is not accessible${hint}`}.`,
  };
}

function resolveOne(args: ResolveOneArgs): ResolveOneResult {
  const orgDefaultIds = nonEmpty(args.orgDefault?.connectionIds);
  const enforced = args.orgDefault?.enforce === true;
  const governing: ExplicitLayer<readonly string[]> | null = args.adminPinIds
    ? {
        ids: args.adminPinIds,
        source: "admin_pin",
        code: "pinned_connection_unavailable",
        noun: "Pinned connection",
      }
    : enforced && orgDefaultIds
      ? { ids: orgDefaultIds, ...orgDefaultLayer(true) }
      : null;
  const override: ExplicitLayer<readonly string[]> | null = args.launchOverride
    ? { ids: args.launchOverride.ids, ...launchOverrideLayer(args.launchOverride.source) }
    : null;
  if (governing && override && override.ids.some((id) => !governing.ids.includes(id))) {
    const by = governing.source === "admin_pin" ? "an admin pin" : "an enforced org default";
    return errorOf(args, {
      code: "override_outranked",
      source: override.source,
      message: `${override.noun}s for ${args.integrationId} fall outside ${by}, which governs this integration — drop the override or name only connections of that set.`,
    });
  }
  const explicit: ExplicitLayer[] = [
    ...(override ? [override] : []),
    ...(governing ? [governing] : []),
    {
      ids: args.memberPinIds,
      source: "member_pin",
      code: "pinned_connection_unavailable",
      noun: "Your pinned connection",
    },
    { ids: enforced ? null : orgDefaultIds, ...orgDefaultLayer(false) },
  ];
  for (const layer of explicit) {
    if (!layer.ids) continue;
    const owned = ownedConns(args, layer.ids);
    if ("missingId" in owned) {
      return {
        kind: "error",
        error: unavailableMemberError(
          args.integrationId,
          layer,
          owned.missingId,
          owned.offAuthKey === undefined ? undefined : offAuthReason(args.auth, owned.offAuthKey),
        ),
      };
    }
    return bindSet(args, owned.rows, layer.source);
  }

  // 6. Fallback.
  const serving = args.candidates.filter((c) => servesSelection(args.auth, c.authKey));
  if (serving.length === 0) {
    // The auth and scopes a connect flow needs, so its consent clears the next resolution.
    const authKey = connectTargetAuthKey(args);
    const requiredScopes = authKey === null ? [] : oauthScopesForAuth(args, authKey);
    return errorOf(args, {
      code: "not_connected",
      ...(authKey !== null ? { authKey } : {}),
      ...(requiredScopes.length > 0 ? { requiredScopes } : {}),
      message:
        args.candidates.length === 0
          ? `Integration '${args.integrationId}' has no connection accessible to this actor.`
          : `Integration '${args.integrationId}' has no connection accessible to this actor on an auth that exposes the agent's selected tools.`,
    });
  }

  // Health plays no part: a dead own row is still the pick, so an expiry never switches accounts.
  const own = serving.filter((c) => isOwnedByActor(args, c));
  if (own.length === 1) return bindSet(args, [own[0]!], "fallback_auto");

  return errorOf(args, {
    code: "must_choose_connection",
    message:
      own.length === 0
        ? `Integration '${args.integrationId}' has only connections shared by other members — choose one explicitly (member pin or run override), or connect your own.`
        : `Multiple connections of yours are available for ${args.integrationId} — pick one.`,
    candidateConnections: serving.map((c) => candidateOf(args, c)),
  });
}

/** The rows a requirement may bind or offer — the 409's candidates and the picker's alike. */
export function servingCandidates<T>(
  req: Pick<IntegrationRequirement, "manifest" | "requiredAuthKey" | "effectiveTools">,
  rows: readonly T[],
  authKeyOf: (row: T) => string,
): T[] {
  const auth = authFilterOf(req);
  return rows.filter((row) => servesSelection(auth, authKeyOf(row)));
}

/** Declared auths, the dep's AFPS §4.1 `auth_key`, auths serving the selection; `null` = any. */
interface AuthFilter {
  live: ReadonlySet<string> | null;
  requiredAuthKey?: string;
  serving: ReadonlySet<string> | null;
}

function authFilterOf(
  req: Pick<IntegrationRequirement, "manifest" | "requiredAuthKey" | "effectiveTools">,
): AuthFilter {
  return {
    live: manifestAuthKeySet(req.manifest),
    serving: authKeysServingSelection(req.manifest, req.effectiveTools),
    ...(req.requiredAuthKey !== undefined ? { requiredAuthKey: req.requiredAuthKey } : {}),
  };
}

function servesSelection(auth: AuthFilter, key: string): boolean {
  return (
    (auth.live === null || auth.live.has(key)) &&
    (auth.requiredAuthKey === undefined || key === auth.requiredAuthKey) &&
    (auth.serving === null || auth.serving.has(key))
  );
}

function servesAuth(args: ResolveOneArgs, authKey: string): boolean {
  return args.auth.serving === null || args.auth.serving.has(authKey);
}

/**
 * The auth a fresh connect flow must target: the dep's declared `auth_key`, else the single
 * serving `oauth2` auth; `null` when that is ambiguous, and the user chooses.
 */
function connectTargetAuthKey(args: ResolveOneArgs): string | null {
  if (args.auth.requiredAuthKey !== undefined) {
    const key = declaredAuthKey(args.manifest, args.auth.requiredAuthKey);
    return key !== null && servesAuth(args, key) ? key : null;
  }
  const oauthKeys = Object.entries(args.manifest.auths ?? {})
    .filter(([key, auth]) => auth.type === "oauth2" && servesAuth(args, key))
    .map(([key]) => key);
  return oauthKeys.length === 1 ? oauthKeys[0]! : null;
}

/** `key` while the manifest still declares it, else `null`: a dropped auth is no connect target. */
function declaredAuthKey(manifest: IntegrationManifest, key: string): string | null {
  return manifest.auths?.[key] ? key : null;
}

function oauthScopesForAuth(args: ResolveOneArgs, authKey: string): string[] {
  if (args.manifest.auths?.[authKey]?.type !== "oauth2") return [];
  return requiredScopesForAgent({
    manifest: args.manifest,
    authKey,
    agentTools: args.agentTools,
    agentScopes: args.agentScopes,
  });
}

function isOwnedByActor(
  actor: ActorIdentity,
  conn: Pick<ConnectionRow, "userId" | "endUserId">,
): boolean {
  return (
    (actor.actorUserId !== null && conn.userId === actor.actorUserId) ||
    (actor.actorEndUserId !== null && conn.endUserId === actor.actorEndUserId)
  );
}

interface ActorIdentity {
  actorUserId: string | null;
  actorEndUserId: string | null;
}

export function actorIdentityOf(actor: Actor): ActorIdentity {
  return {
    actorUserId: actor.type === "user" ? actor.id : null,
    actorEndUserId: actor.type === "end_user" ? actor.id : null,
  };
}

/** Project a candidate row onto the picker-facing shape carried by the 409. */
export function candidateOf(
  actor: ActorIdentity,
  conn: Pick<
    ConnectionRow,
    "id" | "label" | "accountId" | "needsReconnection" | "userId" | "endUserId"
  >,
): ConnectionCandidate {
  return {
    id: conn.id,
    label: conn.label,
    accountId: conn.accountId,
    ownedByActor: isOwnedByActor(actor, conn),
    needsReconnection: conn.needsReconnection,
  };
}

type CheckHealthResult =
  | { kind: "resolved"; value: ResolvedConnection }
  | { kind: "error"; error: ConnectionResolutionError };

function checkHealth(
  args: ResolveOneArgs,
  conn: ConnectionRow,
  source: ResolvedConnection["source"],
): CheckHealthResult {
  const ownedByActor = isOwnedByActor(args, conn);

  // Checked first: neither a reconnect nor a scope upgrade gives this auth a tool.
  if (!servesAuth(args, conn.authKey)) {
    const serving = [...args.auth.serving!].join(", ");
    return errorOf(args, {
      code: "auth_serves_no_selected_tool",
      connectionId: conn.id,
      source,
      message: `Connection '${conn.label}' for ${args.integrationId} uses auth '${conn.authKey}', which exposes none of the agent's selected tools (auths that do: ${serving}) — remove it from the set.`,
    });
  }

  if (conn.needsReconnection) {
    const authKey = declaredAuthKey(args.manifest, conn.authKey);
    const requiredScopes = authKey === null ? [] : oauthScopesForAuth(args, authKey);
    return errorOf(args, {
      code: "needs_reconnection",
      // The reconnect UPDATEs this row in place; without the id it would INSERT a duplicate.
      connectionId: conn.id,
      // One consent covering the selection's scopes, not reconnect → insufficient_scopes.
      ...(authKey !== null ? { authKey } : {}),
      ...(requiredScopes.length > 0 ? { requiredScopes } : {}),
      ownedByActor,
      source,
      message: `Connection for ${args.integrationId} needs to be reconnected.`,
    });
  }

  const missing = missingScopesForConnection({
    manifest: args.manifest,
    authKey: conn.authKey,
    granted: conn.scopesGranted,
    agentTools: args.agentTools,
    agentScopes: args.agentScopes,
  });
  if (missing.length > 0) {
    return errorOf(args, {
      code: "insufficient_scopes",
      connectionId: conn.id,
      authKey: conn.authKey,
      missingScopes: missing,
      // The FULL requirement, not the diff: some providers treat each consent as the whole grant.
      requiredScopes: oauthScopesForAuth(args, conn.authKey),
      ownedByActor,
      source,
      message: `Connection for ${args.integrationId} is missing required permissions: ${missing.join(", ")}.`,
    });
  }

  return {
    kind: "resolved",
    value: { connectionId: conn.id, source, label: conn.label, accountId: conn.accountId },
  };
}

function errorOf(
  args: { integrationId: string },
  partial: Omit<ConnectionResolutionError, "integrationId">,
): { kind: "error"; error: ConnectionResolutionError } {
  return {
    kind: "error",
    error: {
      integrationId: args.integrationId,
      ...partial,
    },
  };
}

// ─────────────────────────── DB orchestrator ──────────────────────────────────

interface ResolveConnectionsForRunInput {
  agentManifest: Record<string, unknown>;
  packageId: string;
  actor: Actor;
  scope: SpaceScope;
  launchOverrides?: LaunchOverrides | null;
  includeInert?: boolean;
  /**
   * Integrations the caller already refused for a more precise reason (readiness:
   * `integration_not_active`), so they do not also report a misleading `not_connected`.
   */
  skipIntegrationIds?: ReadonlySet<string>;
  manifestCache?: IntegrationManifestCache;
}

export async function resolveConnectionsForRun(
  input: ResolveConnectionsForRunInput,
): Promise<ConnectionResolutionResult> {
  const declared = parseManifestIntegrations(input.agentManifest);
  const entries = input.skipIntegrationIds
    ? declared.filter((entry) => !input.skipIntegrationIds!.has(entry.id))
    : declared;
  if (entries.length === 0) return { resolved: {}, errors: [] };

  const requirements = await Promise.all(
    entries.map((entry) => buildRequirement(entry, input.manifestCache)),
  );
  const validReqs = requirements.filter((r): r is IntegrationRequirement => r !== null);

  const { actorUserId, actorEndUserId } = actorIdentityOf(input.actor);

  const integrationIds = validReqs.map((r) => r.integrationId);
  const [accessibleConnections, pins, orgDefaults] = await Promise.all([
    loadAccessibleConnections(input.actor, input.scope.spaceId, integrationIds),
    loadPins(input.scope.spaceId, input.packageId, integrationIds, actorUserId),
    listOrgDefaultsForResolver(input.scope.spaceId),
  ]);

  return resolveConnections({
    requirements: validReqs,
    accessibleConnections,
    pins,
    orgDefaults,
    launchOverrides: input.launchOverrides ?? null,
    actorUserId,
    actorEndUserId,
    includeInert: input.includeInert ?? false,
  });
}

export function missingIntegrationConnection(errors: ValidationFieldError[]): ApiError {
  return new ApiError({
    status: 409,
    code: "missing_integration_connection",
    title: "Missing Integration Connection",
    detail: errors[0]!.message,
    errors,
  });
}

type ResolveRunConnectionsOutcome =
  { ok: true; resolved: ResolvedConnectionMap | null } | { ok: false; error: ApiError };

/** The run's connection snapshot (`null` when empty), else the 409 both kickoff paths relay. */
export async function resolveRunConnectionsOrError(
  input: ResolveConnectionsForRunInput,
): Promise<ResolveRunConnectionsOutcome> {
  const resolution = await resolveConnectionsForRun(input);
  if (resolution.errors.length > 0) {
    return {
      ok: false,
      error: missingIntegrationConnection(resolution.errors.map(translateResolutionError)),
    };
  }
  const resolved = Object.keys(resolution.resolved).length > 0 ? resolution.resolved : null;
  return { ok: true, resolved };
}

/**
 * The resolution codes a connect flow can clear, and so the ones that carry
 * the `auth_key` + `required_scopes` relay: a first connect, a reconnect in
 * place, and a scope upgrade all end at the same consent screen.
 */
const CONNECT_FLOW_CODES: ReadonlySet<ConnectionResolutionError["code"]> = new Set([
  "not_connected",
  "needs_reconnection",
  "insufficient_scopes",
]);

/**
 * Map a `ConnectionResolutionError` to the wire-format `ResolutionFieldError`
 * (a `ValidationFieldError` plus the resolution smuggle fields) the upstream
 * 409 envelope expects.
 *
 * Field path: `integrations.{packageId}` — one error per integration in
 * the flat model. The dashboard's MissingConnectionsModal parses on the
 * same prefix so existing UI plumbing still works.
 */
export function translateResolutionError(e: ConnectionResolutionError): ResolutionFieldError {
  const title = TITLE_BY_CODE[e.code];
  return {
    field: `integrations.${e.integrationId}`,
    code: e.code,
    title,
    message: e.message,
    // Relayed even empty: "none you may pick" is then the answer.
    ...(e.candidateConnections
      ? {
          candidate_connections: e.candidateConnections.map((c) => ({
            id: c.id,
            label: c.label,
            account_id: c.accountId,
            owned_by_actor: c.ownedByActor,
            needs_reconnection: c.needsReconnection,
          })),
        }
      : {}),
    // Forwarded as the connect kickoff's `scopes`, so one consent covers the selection.
    ...(CONNECT_FLOW_CODES.has(e.code)
      ? {
          ...(e.authKey ? { auth_key: e.authKey } : {}),
          ...(e.requiredScopes && e.requiredScopes.length > 0
            ? { required_scopes: e.requiredScopes }
            : {}),
        }
      : {}),
    // Smuggle scope-diff detail on insufficient_scopes so the UI can offer
    // an upgrade (own connection) or a read-only error (foreign owner).
    ...(e.code === "insufficient_scopes"
      ? {
          ...(e.connectionId ? { connection_id: e.connectionId } : {}),
          ...(e.missingScopes && e.missingScopes.length > 0
            ? { missing_scopes: e.missingScopes }
            : {}),
          ...(e.ownedByActor !== undefined ? { owned_by_actor: e.ownedByActor } : {}),
        }
      : {}),
    ...(e.code === "auth_serves_no_selected_tool" && e.connectionId
      ? { connection_id: e.connectionId }
      : {}),
    ...(e.code === "needs_reconnection"
      ? {
          ...(e.connectionId ? { connection_id: e.connectionId } : {}),
          ...(e.ownedByActor !== undefined ? { owned_by_actor: e.ownedByActor } : {}),
        }
      : {}),
    // AFPS §4.1: the dep's `auth_key` and, on a mismatch, the auths the actor's rows use.
    ...(e.code === "auth_key_mismatch" || e.code === "auth_key_serves_no_selected_tool"
      ? {
          ...(e.requiredAuthKey ? { required_auth_key: e.requiredAuthKey } : {}),
          ...(e.availableAuthKeys && e.availableAuthKeys.length > 0
            ? { available_auth_keys: e.availableAuthKeys }
            : {}),
        }
      : {}),
  };
}

const TITLE_BY_CODE: Record<ConnectionResolutionError["code"], string> = {
  not_connected: "Integration Not Connected",
  needs_reconnection: "Needs Reconnection",
  pinned_connection_unavailable: "Pinned Connection Unavailable",
  override_connection_unavailable: "Override Connection Unavailable",
  override_outranked: "Override Outranked By Governance",
  must_choose_connection: "Multiple Connections Available — Pick One",
  insufficient_scopes: "Insufficient Permissions",
  auth_key_mismatch: "Connection Auth Method Mismatch",
  auth_serves_no_selected_tool: "Connection Auth Serves No Selected Tool",
  auth_key_serves_no_selected_tool: "Required Auth Exposes No Selected Tool",
};

async function buildRequirement(
  entry: ManifestIntegrationEntry,
  manifestCache?: IntegrationManifestCache,
): Promise<IntegrationRequirement | null> {
  const res = await fetchIntegrationManifest(entry.id, manifestCache);
  if (!res.ok) return null; // Missing/invalid manifests are surfaced separately by
  //                          the run-readiness check (agent-readiness.ts); the
  //                          resolver ignores them.
  return requirementOf(entry, res.manifest);
}

export function requirementOf(
  entry: ManifestIntegrationEntry,
  manifest: IntegrationManifest,
): IntegrationRequirement {
  const wildcard = entry.tools === "*";
  // The spawn resolver's own selection rule, so every integration it spawns gets a verdict.
  const effectiveTools = resolveEffectiveToolSelection(entry.tools, manifest);
  const hasSelectedTools =
    isToolsWildcard(effectiveTools) || (Array.isArray(effectiveTools) && effectiveTools.length > 0);
  return {
    integrationId: entry.id,
    manifest,
    hasSelectedTools,
    hasRequiredAuth: manifestHasRequiredAuth(manifest),
    // Scope inference stays on the agent's OWN selection: the inherited defaults would newly
    // fail `insufficient_scopes` on connections that work.
    agentTools: wildcard ? "*" : (entry.tools ?? []),
    agentScopes: entry.scopes ?? [],
    ...(effectiveTools !== undefined ? { effectiveTools } : {}),
    ...(entry.auth_key !== undefined ? { requiredAuthKey: entry.auth_key } : {}),
  };
}

async function loadAccessibleConnections(
  actor: Actor,
  spaceId: string,
  integrationIds: string[],
): Promise<ConnectionRow[]> {
  if (integrationIds.length === 0) return [];
  // Own OR shared-with-org, both scoped to THIS space (the
  // spaceId predicate is applied outside the OR) and to the
  // integrations the agent actually requires, to avoid loading the world.
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(
      and(
        inArray(integrationConnections.integrationId, integrationIds),
        eq(integrationConnections.spaceId, spaceId),
        actorOrSharedFilter(actor, integrationConnections),
      ),
    );
  return rows;
}

async function loadPins(
  spaceId: string,
  packageId: string,
  integrationIds: string[],
  actorUserId: string | null,
): Promise<PinRow[]> {
  if (integrationIds.length === 0) return [];
  // Load admin pins (userId IS NULL) plus this actor's own member pins.
  // Other members' pins are filtered out at the SQL layer so the pure
  // resolver never sees them — pin choices are private per actor.
  const scopeFilter =
    actorUserId !== null
      ? or(isNull(integrationPins.userId), eq(integrationPins.userId, actorUserId))!
      : isNull(integrationPins.userId);
  const rows = await db
    .select()
    .from(integrationPins)
    .where(
      and(
        eq(integrationPins.spaceId, spaceId),
        eq(integrationPins.packageId, packageId),
        inArray(integrationPins.integrationId, integrationIds),
        scopeFilter,
      ),
    );
  return rows;
}

// ─────────────────────────── block_user_connections gate ──────────────────────

/**
 * Used at POST /api/integration-connections — refuses non-admin actors
 * when the (space, integration) row has block_user_connections=true.
 * Surfaced as a permission check, not a resolution error, because it
 * fires *before* the connection exists (so the resolver path doesn't
 * see this case in practice).
 */
export async function isUserConnectionCreationBlocked(
  spaceId: string,
  integrationId: string,
): Promise<boolean> {
  // PLACEMENT, not activation (`placementReadFilter` + its `packageShares`
  // join): the flag is this space's decision about an integration it HOLDS, so
  // an ORPHAN row is nobody's decision here. `enabled` is deliberately NOT
  // required — a lock on a switched-off integration is still the space's call.
  const rows = await db
    .select({ blocked: spacePackages.blockUserConnections })
    .from(spacePackages)
    .innerJoin(packages, eq(packages.id, spacePackages.packageId))
    .leftJoin(packageShares, placementShareJoin(spacePackages.packageId, spaceId))
    .where(
      and(
        eq(spacePackages.spaceId, spaceId),
        eq(spacePackages.packageId, integrationId),
        placementReadFilter(spaceId),
      ),
    )
    .limit(1);
  return rows[0]?.blocked === true;
}
