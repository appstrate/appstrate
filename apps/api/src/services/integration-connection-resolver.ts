// SPDX-License-Identifier: Apache-2.0

/**
 * Integration connection resolver — single source of truth for "which
 * connection does this run use for each (integration, authKey)?".
 *
 * Replaces the connection-profile cascade for integrations with a flat
 * 5-mechanism model (see CLAUDE.md "Flat connections + pins"):
 *
 *   1. integration_pins                        → admin force
 *   2. runs.connection_overrides               → caller's run-time choice
 *   3. package_schedules.connection_overrides  → frozen at schedule create
 *   4. integration_member_assignments          → member's persisted pick
 *      per (user, app, agent, integration, authKey). Empty in OSS until
 *      the user explicitly picks via the agent-page picker; replaces
 *      the R5 localStorage hack with a server-side record the resolver
 *      sees on every run.
 *   5. fallback: actor's accessible connections
 *      = own + (shared_with_org AND application match)
 *      → 1 match → auto, 0 → not_connected, N → must_choose
 *
 * The exported `resolveConnections()` is pure — no DB access — so it can
 * be unit-tested with mock arrays. The `resolveConnectionsForRun()`
 * orchestrator below does the DB fanout and feeds the pure function.
 *
 * Provider-side (legacy `connectionProfiles` cascade) is untouched —
 * `resolveProviderProfiles` in `connection-profiles.ts` still runs for
 * those. The two models will converge when the provider sunset lands.
 */

import { and, eq, or, inArray, isNull } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationConnections, integrationPins, applicationPackages } from "@appstrate/db/schema";
import type { InferSelectModel } from "drizzle-orm";
import {
  parseManifestIntegrations,
  type ManifestIntegrationEntry,
} from "@appstrate/core/dependencies";
import {
  expandGrantedScopes,
  requiredAuthKeysForAgent,
  scopesContributedByTools,
  type IntegrationManifest,
  type ConnectionOverrides,
  type ConnectionResolutionError,
  type ConnectionResolutionResult,
  type ResolvedConnection,
  type ResolvedConnectionMap,
} from "@appstrate/core/integration";
import type { Actor } from "../lib/actor.ts";
import { actorFilter } from "../lib/actor.ts";
import type { AppScope } from "../lib/scope.ts";
import { fetchIntegrationManifest } from "./integration-service.ts";

// ─────────────────────────────────── Types ────────────────────────────────────

type ConnectionRow = InferSelectModel<typeof integrationConnections>;
type PinRow = InferSelectModel<typeof integrationPins>;

/**
 * Per-integration requirement compiled from the agent manifest +
 * integration manifest. The pure resolver consumes this — it doesn't
 * need to know how the requiredScopes union was computed.
 */
export interface IntegrationRequirement {
  integrationId: string;
  manifest: IntegrationManifest;
  /** Auths the agent's tool selection actually needs at run-time. */
  requiredAuthKeys: string[];
  /**
   * Scopes the agent's tool selection requires per auth key. The
   * resolver checks the granted set against this — expansion through
   * `availableScopes.implies` is done here, not by the caller.
   *
   * Only meaningful for `oauth2` auths; api_key / basic / custom have
   * opaque grants the IdP doesn't expose.
   */
  requiredScopesByAuth: Record<string, string[]>;
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
   * Actor's `user.id` — used to match member pins (`pins.userId === actorUserId`)
   * in the cascade's layer 4. Null for end-users (they don't have member
   * pins; their connection is selected by the API caller via run overrides).
   */
  actorUserId?: string | null;
}

// ─────────────────────────── Pure resolver (unit-tested) ──────────────────────

/**
 * Walks the 5-mechanism cascade for each (integration, authKey) that
 * the agent requires. Pure — no DB, no async, no IO. Test with mock
 * arrays.
 *
 * Admin pin always wins; member pins only apply when matching the
 * caller's `actorUserId` (which is null for end-users — they never own
 * member pins).
 */
export function resolveConnections(input: ResolveConnectionsInput): ConnectionResolutionResult {
  const resolved: ResolvedConnectionMap = {};
  const errors: ConnectionResolutionError[] = [];

  const { adminPins, memberPins } = indexPins(input.pins, input.actorUserId ?? null);
  const connectionIndex = new Map<string, ConnectionRow>();
  for (const c of input.accessibleConnections) connectionIndex.set(c.id, c);

  for (const req of input.requirements) {
    if (req.requiredAuthKeys.length === 0) continue; // Inert — agent picked 0 tools.

    const perAuth: Record<string, ResolvedConnection> = {};

    for (const authKey of req.requiredAuthKeys) {
      const key = pinKey(req.integrationId, authKey);
      const result = resolveOne({
        integrationId: req.integrationId,
        authKey,
        manifest: req.manifest,
        requiredScopes: req.requiredScopesByAuth[authKey] ?? [],
        adminPinId: adminPins.get(key) ?? null,
        runOverrideId: input.runOverrides?.[req.integrationId]?.[authKey] ?? null,
        scheduleOverrideId: input.scheduleOverrides?.[req.integrationId]?.[authKey] ?? null,
        memberPinId: memberPins.get(key) ?? null,
        accessibleConnections: input.accessibleConnections,
        connectionIndex,
      });

      if (result.kind === "resolved") {
        perAuth[authKey] = result.value;
      } else {
        errors.push(result.error);
      }
    }

    if (Object.keys(perAuth).length > 0) {
      resolved[req.integrationId] = perAuth;
    }
  }

  return { resolved, errors };
}

// ─────────────────────────── Per-auth core ────────────────────────────────────

interface ResolveOneArgs {
  integrationId: string;
  authKey: string;
  manifest: IntegrationManifest;
  requiredScopes: string[];
  adminPinId: string | null;
  runOverrideId: string | null;
  scheduleOverrideId: string | null;
  memberPinId: string | null;
  accessibleConnections: ConnectionRow[];
  connectionIndex: Map<string, ConnectionRow>;
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
        message: `Pinned connection for ${args.integrationId} (${args.authKey}) is not accessible — it may have been deleted or unshared.`,
      });
    }
    return checkHealth(args, conn, "admin_pin");
  }

  // 2. Run override.
  if (args.runOverrideId) {
    const conn = args.connectionIndex.get(args.runOverrideId);
    if (!conn) {
      return errorOf(args, {
        code: "override_connection_unavailable",
        message: `Run-override connection for ${args.integrationId} (${args.authKey}) is not accessible.`,
      });
    }
    return checkHealth(args, conn, "run_override");
  }

  // 3. Schedule override.
  if (args.scheduleOverrideId) {
    const conn = args.connectionIndex.get(args.scheduleOverrideId);
    if (!conn) {
      return errorOf(args, {
        code: "override_connection_unavailable",
        message: `Schedule-override connection for ${args.integrationId} (${args.authKey}) is not accessible.`,
      });
    }
    return checkHealth(args, conn, "schedule_override");
  }

  // 4. Member pin — actor's persisted preference for this agent.
  if (args.memberPinId) {
    const conn = args.connectionIndex.get(args.memberPinId);
    if (!conn) {
      return errorOf(args, {
        code: "pinned_connection_unavailable",
        message: `Your pinned connection for ${args.integrationId} (${args.authKey}) is no longer accessible — it may have been deleted or unshared.`,
      });
    }
    return checkHealth(args, conn, "member_pin");
  }

  // 5. Fallback — actor's accessible connections matching (integration, authKey).
  const candidates = args.accessibleConnections.filter(
    (c) => c.integrationPackageId === args.integrationId && c.authKey === args.authKey,
  );

  if (candidates.length === 0) {
    return errorOf(args, {
      code: "not_connected",
      message: `Integration '${args.integrationId}' (${args.authKey}) has no connection accessible to this actor.`,
    });
  }

  if (candidates.length === 1) {
    return checkHealth(args, candidates[0]!, "fallback_auto");
  }

  // >1 — caller must pick. Surface the candidate ids so the UI can render
  // a picker (label + accountId + shared/owned badge). The picker writes
  // a member pin, so the next run skips this branch and resolves via layer 4.
  return errorOf(args, {
    code: "must_choose_connection",
    message: `Multiple connections available for ${args.integrationId} (${args.authKey}) — pick one.`,
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
      message: `Connection for ${args.integrationId} (${args.authKey}) needs to be reconnected.`,
    });
  }

  // Scope check — oauth2 only.
  const auth = args.manifest.auths?.[args.authKey];
  if (auth?.type === "oauth2" && args.requiredScopes.length > 0) {
    const granted = new Set(
      expandGrantedScopes(conn.scopesGranted ?? [], args.manifest, args.authKey),
    );
    const missing = args.requiredScopes.filter((s) => !granted.has(s));
    if (missing.length > 0) {
      return errorOf(args, {
        code: "insufficient_scopes",
        message: `Connection for ${args.integrationId} (${args.authKey}) is missing scopes: ${missing.join(", ")}.`,
        requiredScopes: args.requiredScopes,
        grantedScopes: conn.scopesGranted ?? [],
      });
    }
  }

  return { kind: "resolved", value: { connectionId: conn.id, source } };
}

function errorOf(
  args: { integrationId: string; authKey: string },
  partial: Omit<ConnectionResolutionError, "integrationId" | "authKey">,
): ResolveOneResult {
  return {
    kind: "error",
    error: {
      integrationId: args.integrationId,
      authKey: args.authKey,
      ...partial,
    },
  };
}

const pinKey = (integrationId: string, authKey: string): string => `${integrationId}|${authKey}`;

/**
 * Partition pins into admin (`userId IS NULL`) and member (matching the
 * actor) buckets. Member pins for OTHER users are silently ignored —
 * each actor sees only their own pin.
 */
function indexPins(
  pins: PinRow[],
  actorUserId: string | null,
): { adminPins: Map<string, string>; memberPins: Map<string, string> } {
  const adminPins = new Map<string, string>();
  const memberPins = new Map<string, string>();
  for (const p of pins) {
    const key = pinKey(p.integrationPackageId, p.authKey);
    if (p.userId === null) {
      adminPins.set(key, p.connectionId);
    } else if (actorUserId !== null && p.userId === actorUserId) {
      memberPins.set(key, p.connectionId);
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

  // Load accessible connections + pins in parallel.
  const integrationIds = validReqs.map((r) => r.integrationId);
  const [accessibleConnections, pins] = await Promise.all([
    loadAccessibleConnections(input.actor, input.scope.applicationId, integrationIds),
    loadPins(input.scope.applicationId, input.packageId, integrationIds, actorUserId),
  ]);

  return resolveConnections({
    requirements: validReqs,
    accessibleConnections,
    pins,
    runOverrides: input.runOverrides ?? null,
    scheduleOverrides: input.scheduleOverrides ?? null,
    actorUserId,
  });
}

async function buildRequirement(
  entry: ManifestIntegrationEntry,
): Promise<IntegrationRequirement | null> {
  const res = await fetchIntegrationManifest(entry.id);
  if (!res.ok) return null; // Missing/invalid manifests are surfaced separately by
  //                          collectIntegrationDependencyErrors during readiness
  //                          checks; the resolver ignores them.
  const manifest = res.manifest;
  const requiredAuthKeys = requiredAuthKeysForAgent(manifest, entry.tools);
  const requiredScopesByAuth: Record<string, string[]> = {};
  for (const authKey of requiredAuthKeys) {
    requiredScopesByAuth[authKey] = scopesContributedByTools({
      manifest,
      authKey,
      agentTools: entry.tools,
    });
  }
  return { integrationId: entry.id, manifest, requiredAuthKeys, requiredScopesByAuth };
}

async function loadAccessibleConnections(
  actor: Actor,
  applicationId: string,
  integrationIds: string[],
): Promise<ConnectionRow[]> {
  if (integrationIds.length === 0) return [];
  // Own (any application — XOR check is on owner) OR shared-with-org
  // matching this application. Both branches scoped to integrations the
  // agent actually requires to avoid loading the world.
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(
      and(
        inArray(integrationConnections.integrationPackageId, integrationIds),
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
        inArray(integrationPins.integrationPackageId, integrationIds),
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
  integrationPackageId: string,
): Promise<boolean> {
  const rows = await db
    .select({ blocked: applicationPackages.blockUserConnections })
    .from(applicationPackages)
    .where(
      and(
        eq(applicationPackages.applicationId, applicationId),
        eq(applicationPackages.packageId, integrationPackageId),
      ),
    )
    .limit(1);
  return rows[0]?.blocked === true;
}
