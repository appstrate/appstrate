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
 *      several oauth2 rows of one known account, auth and instance → the least-privileged
 *      covering the agent (never without an agent selection); otherwise several →
 *      `must_choose_connection`; none → as below
 *
 * Layers 1-5 bind their set whole or fail loudly, never falling through. A launch override
 * under layer 1 or 2 must name a subset of that governing set, which it then narrows to;
 * naming anything outside it is `override_outranked`. A shared connection is never bound
 * implicitly. A layer with no row or key is absent; `[]` wins and binds none. With nothing to
 * bind (or switched off in the space), a `required` integration is an error, any other binds
 * none with a warning carrying the same code — `integration_unbound` (a layer's `[]`) aside.
 * `resolveConnections()` is pure; `resolveConnectionsForRun()` loads its inputs.
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
  expandScopesGranted,
  missingScopesForConnection,
  partitionScopesByAuthCatalog,
  scopesNotCovered,
  requiredScopesForAgent,
  manifestAuthKeySet,
  manifestHasRequiredAuth,
  CONNECT_FLOW_CODES,
  type IntegrationManifest,
  type ConnectionCandidate,
  type ConnectionOverrides,
  type ConnectionResolutionError,
  type ConnectionResolutionResult,
  type ConnectionResolutionSource,
  type ConnectionResolutionWarning,
  type ConnectionResolutionWarningCode,
  type ResolvedConnection,
  type ResolvedConnectionMap,
  type RunIntegrationUnbound,
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
import { listActiveIntegrationIds } from "./integration-connections.ts";
import {
  connectionVariablesOf,
  displayAccountId,
  sameConnectionVariables,
} from "../lib/connection-identity.ts";

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
  hasMandatoryAuth?: boolean;
  /** The agent's `integrations_configuration[id].required` — not {@link hasMandatoryAuth}. */
  required: boolean;
  /** AFPS §4.1 `auth_key`: only rows on that auth are candidates, at every layer. */
  requiredAuthKey?: string;
  /** Effective selection (`tools[]`, else `default_tools`); absent → any auth serves it. */
  effectiveTools?: readonly string[] | "*";
  /** A credential-proxy call: no agent selection, so no scope tells own rows apart. */
  noAgentSelection?: boolean;
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
  /** Declared integrations switched off in the space: never walked through the cascade. */
  inactiveIntegrationIds?: ReadonlySet<string>;
}

// ─────────────────────────── Pure resolver (unit-tested) ──────────────────────

/** Walks the cascade (file header) per integration. */
export function resolveConnections(input: ResolveConnectionsInput): ConnectionResolutionResult {
  const resolved: ResolvedConnectionMap = {};
  const errors: ConnectionResolutionError[] = [];
  const warnings: ConnectionResolutionWarning[] = [];

  const actorUserId = input.actorUserId ?? null;
  const accessibleIndex = new Map(input.accessibleConnections.map((c) => [c.id, c]));
  const pinIds = (integrationId: string, userId: string | null) =>
    input.pins.find((p) => p.integrationId === integrationId && p.userId === userId)
      ?.connectionIds ?? null;
  const record = (integrationId: string, result: ResolveOneResult): void => {
    if (result.kind === "error") {
      errors.push(result.error);
      return;
    }
    // `[]` when unbound, so the run's snapshot lists it with the launch's other unbound ones.
    resolved[integrationId] = result.value;
    if (result.kind === "unbound") warnings.push(result.warning);
  };

  for (const req of input.requirements) {
    // Inert: nothing the spawn resolver would start, so no verdict is needed — unless required.
    if (
      !req.required &&
      !req.hasSelectedTools &&
      req.agentScopes.length === 0 &&
      !req.hasMandatoryAuth &&
      !input.includeInert
    )
      continue;
    if (input.inactiveIntegrationIds?.has(req.integrationId)) {
      record(
        req.integrationId,
        gapOf(req, {
          code: "integration_not_active",
          message: `Integration '${req.integrationId}' is not active in this space`,
        }),
      );
      continue;
    }

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
    const availableAuthKeys =
      req.requiredAuthKey !== undefined && candidates.length === 0 && live.length > 0
        ? [...new Set(live.map((c) => c.authKey))]
        : undefined;
    if (availableAuthKeys && req.required) {
      // Not `not_connected`: that would hide the real cause.
      record(
        req.integrationId,
        gapOf(req, authKeyMismatch({ ...req, auth }, req.requiredAuthKey!, availableAuthKeys)),
      );
      continue;
    }

    const result = resolveOne({
      integrationId: req.integrationId,
      required: req.required,
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
      ...(availableAuthKeys ? { availableAuthKeys } : {}),
      ...(req.noAgentSelection ? { noAgentSelection: true } : {}),
    });

    record(req.integrationId, result);
  }

  return { resolved, errors, warnings };
}

// ─────────────────────────── Per-integration core ─────────────────────────────

function launchOverrideFor(
  launch: LaunchOverrides | null | undefined,
  integrationId: string,
): ResolveOneArgs["launchOverride"] {
  const ids = launch?.ids[integrationId];
  return launch && ids ? { ids, source: launch.source } : null;
}

interface ResolveOneArgs {
  integrationId: string;
  required: boolean;
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
  /** Set when the dep's `auth_key` filtered out every live row: the auths those rows use. */
  availableAuthKeys?: string[];
  noAgentSelection?: boolean;
}

type ResolveOneResult =
  | { kind: "resolved"; value: ResolvedConnection[] }
  | { kind: "unbound"; value: []; warning: ConnectionResolutionWarning }
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

type ExplicitSource = Exclude<ConnectionResolutionSource, "fallback_auto">;

interface ExplicitLayerRef {
  source: ExplicitSource;
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
  const orgDefaultIds = args.orgDefault?.connectionIds ?? null;
  const enforced = args.orgDefault?.enforce === true;
  const governing: ExplicitLayer<readonly string[]> | null =
    args.adminPinIds !== null
      ? {
          ids: args.adminPinIds,
          source: "admin_pin",
          code: "pinned_connection_unavailable",
          noun: "Pinned connection",
        }
      : enforced && orgDefaultIds !== null
        ? { ids: orgDefaultIds, ...orgDefaultLayer(true) }
        : null;
  const override: ExplicitLayer<readonly string[]> | null = args.launchOverride
    ? { ids: args.launchOverride.ids, ...launchOverrideLayer(args.launchOverride.source) }
    : null;
  // `[]` names nothing outside the governing set, so "none" narrows under governance too.
  if (governing && override && override.ids.some((id) => !governing.ids.includes(id))) {
    const by = LAYER_PHRASE[governing.source];
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
    if (layer.ids === null) continue;
    if (layer.ids.length === 0) {
      // No connect target: the absence was chosen.
      if (!args.required) {
        return {
          kind: "unbound",
          value: [],
          warning: {
            integrationId: args.integrationId,
            code: "integration_unbound",
            source: layer.source,
            message: `Integration '${args.integrationId}' is bound to no connection by ${LAYER_PHRASE[layer.source]}; the run proceeds without it.`,
          },
        };
      }
      return errorOf(args, {
        code: "required_integration_unbound",
        source: layer.source,
        boundConnectionIds: [],
        message: `${layer.noun} set for ${args.integrationId} is empty, but the agent requires this integration — name a connection there, or remove the empty set.`,
      });
    }
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
  // Health never switches the pick: a dead own row is still bound and answers needs_reconnection.
  const own = serving.filter((c) => isOwnedByActor(args, c));
  if (own.length === 1) return bindSet(args, [own[0]!], "fallback_auto");
  const sameAccount = own.length > 1 ? leastPrivilegedOfOneAccount(args, own) : null;
  if (sameAccount) return bindSet(args, [sameAccount], "fallback_auto");
  if (own.length > 1) {
    return errorOf(args, {
      code: "must_choose_connection",
      message: `Multiple connections of yours are available for ${args.integrationId} — pick one.`,
      candidateConnections: serving.map((c) => candidateOf(args, c)),
    });
  }
  return gapOf(args, nothingOwnServes(args, serving));
}

/**
 * Own `oauth2` connections of ONE known account, auth and instance (variables) differ only by
 * scopes, so no account is chosen. Ranked by what the agent misses, then what the row grants
 * beyond the agent's scopes and `default_scopes`, then what the defaults miss, then breadth, then
 * health: a narrow row (dead, or short of a newer default) is never traded for a broader one.
 * `null` otherwise, and with no agent selection.
 */
function leastPrivilegedOfOneAccount(
  args: ResolveOneArgs,
  own: ConnectionRow[],
): ConnectionRow | null {
  if (args.noAgentSelection) return null;
  const [first] = own;
  const auth = args.manifest.auths?.[first!.authKey];
  const account = displayAccountId(first!.accountId);
  const variables = connectionVariablesOf(first!.variables);
  if (auth?.type !== "oauth2" || account === null) return null;
  const sameUpstream = (c: ConnectionRow) =>
    c.authKey === first!.authKey &&
    c.accountId === account &&
    sameConnectionVariables(connectionVariablesOf(c.variables), variables);
  if (!own.every(sameUpstream)) return null;
  const { manifest } = args;
  const authKey = first!.authKey;
  const defaults = auth.default_scopes ?? [];
  const allowed = new Set(
    expandScopesGranted([...oauthScopesForAuth(args, authKey), ...defaults], manifest, authKey),
  );
  // Catalog scopes only (IdP echoes aside), `implies` expanded: an umbrella is never narrower.
  const declared = (c: ConnectionRow) =>
    partitionScopesByAuthCatalog(auth, expandScopesGranted(c.scopesGranted, manifest, authKey))
      .declared;
  const ranked = own.map((c) => ({
    c,
    agentMissing: missingScopesForConnection({
      manifest,
      authKey,
      granted: c.scopesGranted,
      agentTools: args.agentTools,
      agentScopes: args.agentScopes,
    }).length,
    excess: declared(c).filter((scope) => !allowed.has(scope)).length,
    defaultMissing: scopesNotCovered(defaults, c.scopesGranted, manifest, authKey).length,
    breadth: declared(c).length,
  }));
  ranked.sort(
    (a, b) =>
      a.agentMissing - b.agentMissing ||
      a.excess - b.excess ||
      a.defaultMissing - b.defaultMissing ||
      a.breadth - b.breadth ||
      Number(a.c.needsReconnection) - Number(b.c.needsReconnection) ||
      a.c.createdAt.getTime() - b.c.createdAt.getTime() ||
      a.c.id.localeCompare(b.c.id),
  );
  return ranked[0]!.c;
}

const LAYER_PHRASE: Record<ExplicitSource, string> = {
  admin_pin: "an admin pin",
  org_default_enforced: "an enforced org default",
  run_override: "this run's connection_overrides",
  schedule_override: "the schedule's connection_overrides",
  member_pin: "your pin",
  org_default: "an org default",
};

/** A degraded state's twin code: a `required` integration in it is refused, any other is not. */
type GapCode = Exclude<ConnectionResolutionWarningCode, "integration_unbound">;

/** The state alone; {@link gapOf} adds the integration and finishes `message` per severity. */
type Gap = Omit<ConnectionResolutionWarning, "integrationId" | "code"> & { code: GapCode };

function gapOf(req: { integrationId: string; required: boolean }, gap: Gap): ResolveOneResult {
  const item = { ...gap, integrationId: req.integrationId };
  return req.required
    ? { kind: "error", error: { ...item, message: `${gap.message}.` } }
    : {
        kind: "unbound",
        value: [],
        warning: { ...item, message: `${gap.message}; the run proceeds without it.` },
      };
}

/** Connecting the dep's own `auth_key` clears it, so it carries that connect target. */
function authKeyMismatch(
  args: ConnectTargetArgs & { integrationId: string },
  requiredAuthKey: string,
  availableAuthKeys: string[],
): Gap {
  return {
    code: "auth_key_mismatch",
    requiredAuthKey,
    availableAuthKeys,
    ...connectTarget(args),
    message: `Integration '${args.integrationId}' requires auth '${requiredAuthKey}' but the actor's accessible connections use [${availableAuthKeys.join(", ")}]`,
  };
}

/** No layer bound a set and the actor owns no serving connection: why. */
function nothingOwnServes(args: ResolveOneArgs, serving: ConnectionRow[]): Gap {
  const { requiredAuthKey } = args.auth;
  if (args.availableAuthKeys && requiredAuthKey !== undefined) {
    return authKeyMismatch(args, requiredAuthKey, args.availableAuthKeys);
  }
  if (serving.length > 0) {
    return {
      code: "must_choose_connection",
      candidateConnections: serving.map((c) => candidateOf(args, c)),
      message: `Integration '${args.integrationId}' has only connections shared by other members — choose one explicitly (member pin or run override), or connect your own`,
    };
  }
  return {
    code: "not_connected",
    ...connectTarget(args),
    message:
      args.candidates.length === 0
        ? `Integration '${args.integrationId}' has no connection accessible to this actor`
        : `Integration '${args.integrationId}' has no connection accessible to this actor on an auth that exposes the agent's selected tools`,
  };
}

type ConnectTargetArgs = Pick<ResolveOneArgs, "manifest" | "auth" | "agentTools" | "agentScopes">;

/** The auth and scopes a connect flow needs, so its consent clears the next resolution. */
function connectTarget(args: ConnectTargetArgs): { authKey?: string; requiredScopes?: string[] } {
  const authKey = connectTargetAuthKey(args);
  if (authKey === null) return {};
  const requiredScopes = oauthScopesForAuth(args, authKey);
  return requiredScopes.length > 0 ? { authKey, requiredScopes } : { authKey };
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

function servesAuth(args: Pick<ResolveOneArgs, "auth">, authKey: string): boolean {
  return args.auth.serving === null || args.auth.serving.has(authKey);
}

/**
 * The auth a fresh connect flow must target: the dep's declared `auth_key`, else the single
 * serving auth of any type, else the single serving `oauth2` one (the only type a connect link
 * is minted for); `null` when that is ambiguous, and the user chooses.
 */
function connectTargetAuthKey(args: ConnectTargetArgs): string | null {
  if (args.auth.requiredAuthKey !== undefined) {
    const key = declaredAuthKey(args.manifest, args.auth.requiredAuthKey);
    return key !== null && servesAuth(args, key) ? key : null;
  }
  const serving = Object.entries(args.manifest.auths ?? {}).filter(([key]) =>
    servesAuth(args, key),
  );
  const pick = serving.length === 1 ? serving : serving.filter(([, a]) => a.type === "oauth2");
  return pick.length === 1 ? pick[0]![0] : null;
}

/** `key` while the manifest still declares it, else `null`: a dropped auth is no connect target. */
function declaredAuthKey(manifest: IntegrationManifest, key: string): string | null {
  return manifest.auths?.[key] ? key : null;
}

function oauthScopesForAuth(args: ConnectTargetArgs, authKey: string): string[] {
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
    return errorOf(args, {
      code: "needs_reconnection",
      // The reconnect UPDATEs this row in place; without the id it would INSERT a duplicate.
      connectionId: conn.id,
      // No `requiredScopes`: the reconnect re-consents what the row holds plus `default_scopes`,
      // adding no agent's scopes; a row still short afterwards answers `insufficient_scopes`.
      ...(authKey !== null ? { authKey } : {}),
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
  manifestCache?: IntegrationManifestCache;
}

export async function resolveConnectionsForRun(
  input: ResolveConnectionsForRunInput,
): Promise<ConnectionResolutionResult> {
  const entries = parseManifestIntegrations(input.agentManifest);
  if (entries.length === 0) return { resolved: {}, errors: [], warnings: [] };

  const requirements = await Promise.all(
    entries.map((entry) => buildRequirement(entry, input.manifestCache)),
  );
  const validReqs = requirements.filter((r): r is IntegrationRequirement => r !== null);

  const { actorUserId, actorEndUserId } = actorIdentityOf(input.actor);

  const integrationIds = validReqs.map((r) => r.integrationId);
  const [accessibleConnections, pins, orgDefaults, activeIds] = await Promise.all([
    loadAccessibleConnections(input.actor, input.scope.spaceId, integrationIds),
    loadPins(input.scope.spaceId, input.packageId, integrationIds, actorUserId),
    listOrgDefaultsForResolver(input.scope.spaceId),
    listActiveIntegrationIds(integrationIds, input.scope.spaceId),
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
    inactiveIntegrationIds: new Set(integrationIds.filter((id) => !activeIds.has(id))),
  });
}

/** `versionRef`: the launch's `runs.version_ref`, not necessarily the draft readiness reads. */
export function missingIntegrationConnection(
  errors: ValidationFieldError[],
  versionRef?: string,
): ApiError {
  return new ApiError({
    status: 409,
    code: "missing_integration_connection",
    title: "Missing Integration Connection",
    detail: errors[0]!.message,
    errors,
    ...(versionRef ? { extensions: { version_ref: versionRef } } : {}),
  });
}

type ResolveRunConnectionsOutcome =
  | {
      ok: true;
      resolved: ResolvedConnectionMap | null;
      /** One per `[]` of `resolved`: its warning as the run records it. */
      integrationsUnbound: RunIntegrationUnbound[];
    }
  | { ok: false; error: ApiError };

/** The run's connection snapshot (`null` when empty, all-`[]` kept), else the kickoff 409. */
export async function resolveRunConnectionsOrError(
  input: ResolveConnectionsForRunInput,
  versionRef: string,
): Promise<ResolveRunConnectionsOutcome> {
  const resolution = await resolveConnectionsForRun(input);
  if (resolution.errors.length > 0) {
    return {
      ok: false,
      error: missingIntegrationConnection(
        resolution.errors.map(translateResolutionError),
        versionRef,
      ),
    };
  }
  const resolved = Object.keys(resolution.resolved).length > 0 ? resolution.resolved : null;
  const integrationsUnbound = resolution.warnings.map(({ integrationId, code, source }) => ({
    integrationId,
    code,
    ...(source ? { source } : {}),
  }));
  return { ok: true, resolved, integrationsUnbound };
}

type ResolutionItem = ConnectionResolutionError | ConnectionResolutionWarning;

const connectFlowCodes: ReadonlySet<string> = new Set(CONNECT_FLOW_CODES);

/**
 * A resolution error (a 409 item) or warning (a launch `warnings` item) as the wire-format
 * `ResolutionFieldError`, one per integration on `integrations.{packageId}`.
 */
export function translateResolutionError(e: ResolutionItem): ResolutionFieldError {
  const title = TITLE_BY_CODE[e.code];
  return {
    field: `integrations.${e.integrationId}`,
    code: e.code,
    title,
    message: e.message,
    ...(e.source ? { source: e.source } : {}),
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
    ...(connectFlowCodes.has(e.code)
      ? {
          ...(e.authKey ? { auth_key: e.authKey } : {}),
          ...(e.requiredScopes && e.requiredScopes.length > 0
            ? { required_scopes: e.requiredScopes }
            : {}),
        }
      : {}),
    // Scope-diff detail on insufficient_scopes: the caller chooses between a new
    // connection and an upgrade (own connection only), or reports it (foreign owner).
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

const TITLE_BY_CODE: Record<ResolutionItem["code"], string> = {
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
  required_integration_unbound: "Required Integration Bound To No Connection",
  integration_not_active: "Integration Not Active",
  integration_unbound: "Integration Bound To No Connection — Run Proceeds Without It",
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
    hasMandatoryAuth: manifestHasRequiredAuth(manifest),
    required: entry.required === true,
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
