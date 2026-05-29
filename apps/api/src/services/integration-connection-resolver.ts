// SPDX-License-Identifier: Apache-2.0

/**
 * Integration connection resolver — single source of truth for "which
 * connection does this run use for each (integration, authKey)?".
 *
 * Flat resolution cascade (highest precedence first):
 *
 *   1. integration_pins (user_id IS NULL)      → admin force, per-agent
 *   2. integration_org_defaults (enforce)      → org-wide force, all agents
 *   3. runs.connection_overrides               → caller's run-time choice
 *   4. package_schedules.connection_overrides  → frozen at schedule create
 *   5. integration_pins (user_id = actor)      → member's persisted pick
 *      per (user, app, agent, integration). Empty in OSS until the user
 *      explicitly picks via the agent-page picker; a server-side record
 *      the resolver sees on every run.
 *   6. integration_org_defaults (soft)         → org-wide default, all agents
 *   7. fallback: actor's accessible connections
 *      = own + (shared_with_org AND application match)
 *      → 1 match → auto, 0 → not_connected, N → must_choose
 *
 * The exported `resolveConnections()` is pure — no DB access — so it can
 * be unit-tested with mock arrays. The `resolveConnectionsForRun()`
 * orchestrator below does the DB fanout and feeds the pure function.
 */

import { and, eq, or, inArray, isNull } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationConnections, integrationPins, applicationPackages } from "@appstrate/db/schema";
import type {
  IntegrationConnectionRow as ConnectionRow,
  IntegrationPinRow as PinRow,
} from "@appstrate/db/schema";
import {
  parseManifestIntegrations,
  type ManifestIntegrationEntry,
} from "@appstrate/core/dependencies";
import {
  missingScopesForConnection,
  type IntegrationManifest,
  type ConnectionOverrides,
  type ConnectionResolutionError,
  type ConnectionResolutionResult,
  type ResolvedConnection,
  type ResolvedConnectionMap,
} from "@appstrate/core/integration";
import type { ValidationFieldError } from "../lib/errors.ts";
import type { Actor } from "../lib/actor.ts";
import { actorFilter } from "../lib/actor.ts";
import type { AppScope } from "../lib/scope.ts";
import { fetchIntegrationManifest } from "./integration-service.ts";
import { listOrgDefaultsForResolver } from "./integration-org-defaults-service.ts";

// ─────────────────────────────────── Types ────────────────────────────────────

/**
 * Per-integration requirement compiled from the agent manifest. With the
 * flat model the resolver only needs to know "this integration is
 * needed" — the per-tool `required_scopes` map survives as input to OAuth
 * consent (which scopes to request at first-connect), not as a runtime
 * selector. Any connection on the integration is a valid runtime pick.
 */
export interface IntegrationRequirement {
  integrationId: string;
  manifest: IntegrationManifest;
  /**
   * True when the agent's `tools[]` selection is non-empty OR the wildcard
   * literal `"*"` — i.e. the integration is actually used at run time.
   * Empty-selection integrations are declared-but-inert and skipped by the
   * resolver.
   */
  hasSelectedTools: boolean;
  /**
   * The agent's selected tool names on this integration. Drives OAuth
   * scope requirement inference (`requiredScopesForAgent`) so the
   * resolver can flag a resolved connection that lacks the scopes the
   * selected tools need. Empty when no tools selected. The AFPS §4.4
   * wildcard literal `"*"` means "all upstream tools" — scope inference
   * then falls back to the auth's `default_scopes` (§7.4).
   */
  agentTools: readonly string[] | "*";
  /**
   * The agent's explicitly-selected oauth scopes on this integration.
   * apiCall integrations expose no MCP tools, so this is
   * the only scope signal for them. Empty when none selected.
   */
  agentScopes: readonly string[];
  /**
   * AFPS §4.1 `auth_key` — when set, restricts the candidate
   * connection set to rows whose `authKey === requiredAuthKey`
   * BEFORE the cascade runs. `undefined` keeps the existing flat-model
   * semantics (any connection on the integration is a valid pick).
   */
  requiredAuthKey?: string;
}

export interface ResolveConnectionsInput {
  /** The integrations this run needs and what they need from each. */
  requirements: IntegrationRequirement[];
  /**
   * Connections visible to the actor for this run — own + (shared AND
   * matching application). The caller is responsible for the
   * (actor, application) filter; the resolver just enumerates.
   */
  accessibleConnections: ConnectionRow[];
  /**
   * Pins for (application, agent). Mixed — both admin pins (`userId IS NULL`,
   * applies to every actor) and member pins (`userId = actor`, the actor's
   * own preference). The pure resolver filters between them based on
   * `actorUserId`; the caller can either pass the admin-only subset (used
   * by the runtime which has no actor context for admin force) or the
   * full mix.
   */
  pins: PinRow[];
  /** Caller's run-time override map (POST /api/runs body). */
  runOverrides?: ConnectionOverrides | null;
  /** Schedule's frozen override map (package_schedules row). */
  scheduleOverrides?: ConnectionOverrides | null;
  /**
   * Org-wide default connection per integration (application-scoped, all
   * agents). `enforce: true` locks every actor (layer 2, just below the
   * per-agent admin pin); `enforce: false` is a soft default (layer 6,
   * just above the fallback — a member pin still wins). Absent in OSS
   * until an admin sets one; the resolver then behaves exactly as before.
   */
  orgDefaults?: Record<string, { connectionId: string; enforce: boolean }> | null;
  /**
   * Actor's `user.id` — used to match member pins (`pins.userId === actorUserId`)
   * in the cascade's layer 4. Null for end-users (they don't have member
   * pins; their connection is selected by the API caller via run overrides).
   */
  actorUserId?: string | null;
  /**
   * Actor's `end_user.id` when the run is impersonated. Used only to
   * decide whether a resolved-but-under-scoped connection is owned by the
   * current actor (drives `ownedByActor` on `insufficient_scopes`).
   */
  actorEndUserId?: string | null;
}

// ─────────────────────────── Pure resolver (unit-tested) ──────────────────────

/**
 * Walks the cascade per integration. One connection per integration,
 * regardless of authKey — the chosen connection carries its own authKey,
 * which drives credential injection downstream.
 *
 * Cascade per integration:
 *   1. admin pin                 (pins where user_id IS NULL)         — per-agent force
 *   2. org default ENFORCE       (orgDefaults[id].enforce === true)   — org-wide force
 *   3. run override              (runs.connection_overrides)
 *   4. schedule override         (package_schedules.connection_overrides)
 *   5. member pin                (pins where user_id = actor.id)      — per-agent preference
 *   6. org default SOFT          (orgDefaults[id].enforce === false)  — org-wide default
 *   7. fallback                  (actor's accessible connections on this integration)
 *
 * Force layers (admin pin, enforce default) sit at the top; the per-agent
 * admin pin beats the org-wide enforce default (agent-specific exception).
 * The soft default sits just above the fallback so a member's explicit pin
 * still wins. Member pins only apply when matching the caller's
 * `actorUserId` (null for end-users — they never own member pins).
 */
export function resolveConnections(input: ResolveConnectionsInput): ConnectionResolutionResult {
  const resolved: ResolvedConnectionMap = {};
  const errors: ConnectionResolutionError[] = [];

  const { adminPins, memberPins } = indexPins(input.pins, input.actorUserId ?? null);
  const connectionIndex = new Map<string, ConnectionRow>();
  for (const c of input.accessibleConnections) connectionIndex.set(c.id, c);

  for (const req of input.requirements) {
    // Inert only when the agent picked neither tools nor scopes. apiCall
    // integrations expose no tools, so scope selection keeps them active.
    if (!req.hasSelectedTools && req.agentScopes.length === 0) continue;

    // AFPS §4.1 `auth_key`: when the agent dep pins an auth method,
    // restrict the candidate connection set to rows on that auth BEFORE
    // running the cascade. The chosen connection's authKey carries through
    // to credential injection downstream; pre-filtering here means every
    // cascade layer (pins / overrides / fallback) honours the pin uniformly.
    const integrationCandidates = input.accessibleConnections.filter(
      (c) => c.integrationId === req.integrationId,
    );
    let filteredConnections = input.accessibleConnections;
    let filteredIndex = connectionIndex;
    if (req.requiredAuthKey !== undefined) {
      const matchingOnAuth = integrationCandidates.filter((c) => c.authKey === req.requiredAuthKey);
      if (matchingOnAuth.length === 0 && integrationCandidates.length > 0) {
        // The actor has connections on this integration but none on the
        // requested auth — surface a structured mismatch error rather than
        // letting the cascade fall through to `not_connected` (which would
        // hide the real cause).
        errors.push({
          integrationId: req.integrationId,
          code: "auth_key_mismatch",
          requiredAuthKey: req.requiredAuthKey,
          availableAuthKeys: [...new Set(integrationCandidates.map((c) => c.authKey))],
          message: `Integration '${req.integrationId}' requires auth '${req.requiredAuthKey}' but the actor's accessible connections use [${[
            ...new Set(integrationCandidates.map((c) => c.authKey)),
          ].join(", ")}].`,
        });
        continue;
      }
      // Build a restricted view so the cascade only sees matching connections.
      // Other integrations' rows are untouched.
      const otherRows = input.accessibleConnections.filter(
        (c) => c.integrationId !== req.integrationId,
      );
      filteredConnections = [...otherRows, ...matchingOnAuth];
      filteredIndex = new Map<string, ConnectionRow>();
      for (const c of filteredConnections) filteredIndex.set(c.id, c);
    }

    const result = resolveOne({
      integrationId: req.integrationId,
      manifest: req.manifest,
      agentTools: req.agentTools,
      agentScopes: req.agentScopes,
      adminPinId: adminPins.get(req.integrationId) ?? null,
      orgDefault: input.orgDefaults?.[req.integrationId] ?? null,
      runOverrideId: input.runOverrides?.[req.integrationId] ?? null,
      scheduleOverrideId: input.scheduleOverrides?.[req.integrationId] ?? null,
      memberPinId: memberPins.get(req.integrationId) ?? null,
      accessibleConnections: filteredConnections,
      connectionIndex: filteredIndex,
      actorUserId: input.actorUserId ?? null,
      actorEndUserId: input.actorEndUserId ?? null,
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

interface ResolveOneArgs {
  integrationId: string;
  manifest: IntegrationManifest;
  agentTools: readonly string[] | "*";
  agentScopes: readonly string[];
  adminPinId: string | null;
  orgDefault: { connectionId: string; enforce: boolean } | null;
  runOverrideId: string | null;
  scheduleOverrideId: string | null;
  memberPinId: string | null;
  accessibleConnections: ConnectionRow[];
  connectionIndex: Map<string, ConnectionRow>;
  actorUserId: string | null;
  actorEndUserId: string | null;
}

type ResolveOneResult =
  | { kind: "resolved"; value: ResolvedConnection }
  | { kind: "error"; error: ConnectionResolutionError };

function resolveOne(args: ResolveOneArgs): ResolveOneResult {
  // 1. Admin pin (highest precedence — locks the choice for every actor).
  if (args.adminPinId) {
    const conn = args.connectionIndex.get(args.adminPinId);
    if (!conn) {
      return errorOf(args, {
        code: "pinned_connection_unavailable",
        message: `Pinned connection for ${args.integrationId} is not accessible — it may have been deleted or unshared.`,
      });
    }
    return checkHealth(args, conn, "admin_pin");
  }

  // 2. Org default ENFORCE — org-wide force, locks every actor on every
  // agent. Beaten only by the per-agent admin pin above.
  if (args.orgDefault?.enforce) {
    const conn = args.connectionIndex.get(args.orgDefault.connectionId);
    if (!conn) {
      return errorOf(args, {
        code: "pinned_connection_unavailable",
        message: `Org default connection for ${args.integrationId} is not accessible — it may have been deleted or unshared.`,
      });
    }
    return checkHealth(args, conn, "org_default_enforced");
  }

  // 3. Run override.
  if (args.runOverrideId) {
    const conn = args.connectionIndex.get(args.runOverrideId);
    if (!conn) {
      return errorOf(args, {
        code: "override_connection_unavailable",
        message: `Run-override connection for ${args.integrationId} is not accessible.`,
      });
    }
    return checkHealth(args, conn, "run_override");
  }

  // 4. Schedule override.
  if (args.scheduleOverrideId) {
    const conn = args.connectionIndex.get(args.scheduleOverrideId);
    if (!conn) {
      return errorOf(args, {
        code: "override_connection_unavailable",
        message: `Schedule-override connection for ${args.integrationId} is not accessible.`,
      });
    }
    return checkHealth(args, conn, "schedule_override");
  }

  // 5. Member pin — actor's persisted preference for this agent.
  if (args.memberPinId) {
    const conn = args.connectionIndex.get(args.memberPinId);
    if (!conn) {
      return errorOf(args, {
        code: "pinned_connection_unavailable",
        message: `Your pinned connection for ${args.integrationId} is no longer accessible — it may have been deleted or unshared.`,
      });
    }
    return checkHealth(args, conn, "member_pin");
  }

  // 6. Org default SOFT — org-wide baseline, just above the fallback. A
  // missing connection (deleted/unshared) silently falls through to the
  // fallback rather than erroring, since the default is non-binding.
  if (args.orgDefault) {
    const conn = args.connectionIndex.get(args.orgDefault.connectionId);
    if (conn) return checkHealth(args, conn, "org_default");
  }

  // 7. Fallback — actor's accessible connections on this integration,
  // any auth shape. The chosen connection carries its own authKey.
  const candidates = args.accessibleConnections.filter(
    (c) => c.integrationId === args.integrationId,
  );

  if (candidates.length === 0) {
    return errorOf(args, {
      code: "not_connected",
      message: `Integration '${args.integrationId}' has no connection accessible to this actor.`,
    });
  }

  if (candidates.length === 1) {
    return checkHealth(args, candidates[0]!, "fallback_auto");
  }

  // >1 — caller must pick. Surface the candidate ids so the UI can render
  // a picker (label + accountId + shared/owned badge). The picker writes
  // a member pin, so the next run skips this branch and resolves via layer 5.
  return errorOf(args, {
    code: "must_choose_connection",
    message: `Multiple connections available for ${args.integrationId} — pick one.`,
    candidateConnectionIds: candidates.map((c) => c.id),
  });
}

function checkHealth(
  args: ResolveOneArgs,
  conn: ConnectionRow,
  source: ResolvedConnection["source"],
): ResolveOneResult {
  if (conn.needsReconnection) {
    return errorOf(args, {
      code: "needs_reconnection",
      // Thread the connection id so the modal's reconnect CTA can pass
      // it back through the OAuth callback as the `connectionId` of the
      // existing row to UPDATE — without it, the callback INSERTs a
      // duplicate row (integration-connections.ts:721 "explicit
      // connectionId = update; no id = insert").
      connectionId: conn.id,
      message: `Connection for ${args.integrationId} needs to be reconnected.`,
    });
  }

  // Scope sufficiency on the RESOLVED connection only. The agent's
  // selected tools dictate the required OAuth scopes for the connection's
  // own auth; api_key/basic auths contribute no scopes so this is a no-op
  // for them. Granted scopes are expanded through the manifest `implies`
  // hierarchy before the diff so a parent grant covers its children.
  const missing = missingScopesForConnection({
    manifest: args.manifest,
    authKey: conn.authKey,
    granted: conn.scopesGranted,
    agentTools: args.agentTools,
    agentScopes: args.agentScopes,
  });
  if (missing.length > 0) {
    const ownedByActor =
      (args.actorUserId !== null && conn.userId === args.actorUserId) ||
      (args.actorEndUserId !== null && conn.endUserId === args.actorEndUserId);
    return errorOf(args, {
      code: "insufficient_scopes",
      connectionId: conn.id,
      missingScopes: missing,
      ownedByActor,
      message: `Connection for ${args.integrationId} is missing required permissions: ${missing.join(", ")}.`,
    });
  }

  return { kind: "resolved", value: { connectionId: conn.id, source } };
}

function errorOf(
  args: { integrationId: string },
  partial: Omit<ConnectionResolutionError, "integrationId">,
): ResolveOneResult {
  return {
    kind: "error",
    error: {
      integrationId: args.integrationId,
      ...partial,
    },
  };
}

/**
 * Partition pins into admin (`userId IS NULL`) and member (matching the
 * actor) buckets. Member pins for OTHER users are silently ignored —
 * each actor sees only their own pin. Keyed by integrationId only — one
 * pin per (agent, integration, scope).
 */
function indexPins(
  pins: PinRow[],
  actorUserId: string | null,
): { adminPins: Map<string, string>; memberPins: Map<string, string> } {
  const adminPins = new Map<string, string>();
  const memberPins = new Map<string, string>();
  for (const p of pins) {
    if (p.userId === null) {
      adminPins.set(p.integrationId, p.connectionId);
    } else if (actorUserId !== null && p.userId === actorUserId) {
      memberPins.set(p.integrationId, p.connectionId);
    }
  }
  return { adminPins, memberPins };
}

// ─────────────────────────── DB orchestrator ──────────────────────────────────

/**
 * The fat path: load every input from DB, then run the pure resolver.
 *
 * Caller passes the agent manifest (already loaded — usually from the
 * package row). Integration manifests are fetched here. Pins,
 * connections, override columns are all read in parallel.
 */
export interface ResolveConnectionsForRunInput {
  agentManifest: Record<string, unknown>;
  packageId: string;
  actor: Actor;
  scope: AppScope;
  runOverrides?: ConnectionOverrides | null;
  scheduleOverrides?: ConnectionOverrides | null;
}

export async function resolveConnectionsForRun(
  input: ResolveConnectionsForRunInput,
): Promise<ConnectionResolutionResult> {
  const entries = parseManifestIntegrations(input.agentManifest);
  if (entries.length === 0) return { resolved: {}, errors: [] };

  // Fetch integration manifests in parallel — most agents declare 1-3.
  const requirements = await Promise.all(entries.map((entry) => buildRequirement(entry)));
  const validReqs = requirements.filter((r): r is IntegrationRequirement => r !== null);

  // End-users never own member pins — only dashboard users can pin via
  // /api/me/integration-pins. Passing null narrows the pin partition to
  // admin pins only, keeping the cascade tight for end-user runs.
  const actorUserId = input.actor.type === "user" ? input.actor.id : null;
  const actorEndUserId = input.actor.type === "end_user" ? input.actor.id : null;

  // Load accessible connections + pins + org defaults in parallel.
  const integrationIds = validReqs.map((r) => r.integrationId);
  const [accessibleConnections, pins, orgDefaults] = await Promise.all([
    loadAccessibleConnections(input.actor, input.scope.applicationId, integrationIds),
    loadPins(input.scope.applicationId, input.packageId, integrationIds, actorUserId),
    listOrgDefaultsForResolver(input.scope.applicationId),
  ]);

  return resolveConnections({
    requirements: validReqs,
    accessibleConnections,
    pins,
    orgDefaults,
    runOverrides: input.runOverrides ?? null,
    scheduleOverrides: input.scheduleOverrides ?? null,
    actorUserId,
    actorEndUserId,
  });
}

/**
 * The fully-formed `missing_integration_connection` 412 payload, transport-
 * agnostic. Both run-kickoff paths (run-pipeline throws an `ApiError`,
 * run-creation returns a result object) surface the identical shape; this is
 * the single definition of that shape.
 */
export interface MissingConnectionError {
  status: 412;
  code: "missing_integration_connection";
  title: "Missing Integration Connection";
  detail: string;
  errors: ValidationFieldError[];
}

export type ResolveRunConnectionsOutcome =
  | { ok: true; resolved: ResolvedConnectionMap | null }
  | { ok: false; error: MissingConnectionError };

/**
 * Resolve the per-run connection snapshot and fold any resolver errors into
 * the canonical `missing_integration_connection` 412 payload. Returns a
 * discriminated union so each caller adapts the error to its own transport —
 * `run-pipeline.ts` rethrows it as an `ApiError`, `run-creation.ts` maps it
 * into its `{ ok: false, error }` result convention. The resolution + the
 * empty→null projection + the error mapping live here once so the two
 * kickoff paths can never drift on the 412 shape.
 */
export async function resolveRunConnectionsOrError(
  input: ResolveConnectionsForRunInput,
): Promise<ResolveRunConnectionsOutcome> {
  const resolution = await resolveConnectionsForRun(input);
  if (resolution.errors.length > 0) {
    return {
      ok: false,
      error: {
        status: 412,
        code: "missing_integration_connection",
        title: "Missing Integration Connection",
        detail: resolution.errors[0]!.message,
        errors: resolution.errors.map(translateResolutionError),
      },
    };
  }
  // Project an empty map to `null` ("no integrations declared / no picks").
  const resolved = Object.keys(resolution.resolved).length > 0 ? resolution.resolved : null;
  return { ok: true, resolved };
}

/**
 * Map a `ConnectionResolutionError` to the wire-format ValidationFieldError
 * the upstream 412 envelope expects.
 *
 * Field path: `integrations.{packageId}` — one error per integration in
 * the flat model. The dashboard's MissingConnectionsModal parses on the
 * same prefix so existing UI plumbing still works.
 */
export function translateResolutionError(e: ConnectionResolutionError): ValidationFieldError {
  const title = TITLE_BY_CODE[e.code];
  return {
    field: `integrations.${e.integrationId}`,
    code: e.code,
    title,
    message: e.message,
    // Smuggle the candidate ids on must_choose_connection so the modal
    // can render a picker.
    ...(e.candidateConnectionIds && e.candidateConnectionIds.length > 0
      ? { candidateConnectionIds: e.candidateConnectionIds }
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
    // Surface the dead connection id on needs_reconnection so the modal's
    // reconnect CTA can UPDATE the existing row in place. Omitting it makes
    // the OAuth callback INSERT a duplicate (single-writer contract in
    // integration-connections.ts).
    ...(e.code === "needs_reconnection" && e.connectionId ? { connection_id: e.connectionId } : {}),
    // AFPS §4.1 — surface the pinned `auth_key` (the agent dep's choice)
    // and which auth_keys the actor's existing connections use, so the UI
    // can guide the user to connect via the right auth method.
    ...(e.code === "auth_key_mismatch"
      ? {
          ...(e.requiredAuthKey ? { required_auth_key: e.requiredAuthKey } : {}),
          ...(e.availableAuthKeys && e.availableAuthKeys.length > 0
            ? { available_auth_keys: e.availableAuthKeys }
            : {}),
        }
      : {}),
  } as ValidationFieldError;
}

const TITLE_BY_CODE: Record<ConnectionResolutionError["code"], string> = {
  not_connected: "Integration Not Connected",
  needs_reconnection: "Needs Reconnection",
  connection_blocked_by_admin: "Connection Blocked by Admin",
  pinned_connection_unavailable: "Pinned Connection Unavailable",
  override_connection_unavailable: "Override Connection Unavailable",
  must_choose_connection: "Multiple Connections Available — Pick One",
  insufficient_scopes: "Insufficient Permissions",
  auth_key_mismatch: "Connection Auth Method Mismatch",
};

async function buildRequirement(
  entry: ManifestIntegrationEntry,
): Promise<IntegrationRequirement | null> {
  const res = await fetchIntegrationManifest(entry.id);
  if (!res.ok) return null; // Missing/invalid manifests are surfaced separately by
  //                          the run-readiness check (agent-readiness.ts); the
  //                          resolver ignores them.
  // AFPS §4.4 wildcard — `tools: "*"` counts as a non-empty selection (the
  // agent opted into every upstream tool); thread the literal through so
  // `requiredScopesForAgent` can branch to the auth's `default_scopes`.
  const wildcard = entry.tools === "*";
  const hasArrayTools = Array.isArray(entry.tools) && entry.tools.length > 0;
  return {
    integrationId: entry.id,
    manifest: res.manifest,
    hasSelectedTools: wildcard || hasArrayTools,
    agentTools: wildcard ? "*" : (entry.tools ?? []),
    agentScopes: entry.scopes ?? [],
    ...(entry.auth_key !== undefined ? { requiredAuthKey: entry.auth_key } : {}),
  };
}

async function loadAccessibleConnections(
  actor: Actor,
  applicationId: string,
  integrationIds: string[],
): Promise<ConnectionRow[]> {
  if (integrationIds.length === 0) return [];
  // Own OR shared-with-org, both scoped to THIS application (the
  // applicationId predicate is applied outside the OR) and to the
  // integrations the agent actually requires, to avoid loading the world.
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(
      and(
        inArray(integrationConnections.integrationId, integrationIds),
        eq(integrationConnections.applicationId, applicationId),
        or(
          actorFilter(actor, {
            userId: integrationConnections.userId,
            endUserId: integrationConnections.endUserId,
          }),
          eq(integrationConnections.sharedWithOrg, true),
        )!,
      ),
    );
  return rows;
}

async function loadPins(
  applicationId: string,
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
        eq(integrationPins.applicationId, applicationId),
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
 * when the (application, integration) row has block_user_connections=true.
 * Surfaced as a permission check, not a resolution error, because it
 * fires *before* the connection exists (so the resolver path doesn't
 * see this case in practice).
 */
export async function isUserConnectionCreationBlocked(
  applicationId: string,
  integrationId: string,
): Promise<boolean> {
  const rows = await db
    .select({ blocked: applicationPackages.blockUserConnections })
    .from(applicationPackages)
    .where(
      and(
        eq(applicationPackages.applicationId, applicationId),
        eq(applicationPackages.packageId, integrationId),
      ),
    )
    .limit(1);
  return rows[0]?.blocked === true;
}
