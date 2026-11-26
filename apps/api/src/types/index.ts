// SPDX-License-Identifier: Apache-2.0

// Only re-export types actually imported through this path (backend-only consumers).
// All other shared types should be imported directly from "@appstrate/shared-types".
export type { OrgRole } from "@appstrate/shared-types";

// --- Agent Manifest Types ---
// Re-exported from @appstrate/validation. The AgentManifest type is Zod-inferred
// and covers all agent manifest fields (name, version, type, dependencies, input/output, timeout).

import type { z } from "zod";
import type { AgentManifest } from "@appstrate/core/validation";
import type { orgSettingsReadSchema } from "@appstrate/core/permissions";

/**
 * The stored `org_settings` document as read: `personal_space_role` is a preset there, never the
 * custom default (`organizations.personal_space_role_id`), so it is not the served `OrgSettings`.
 */
type StoredOrgSettings = z.output<typeof orgSettingsReadSchema>;
export type { AgentManifest };

// --- Loaded Package (manifest + prompt from DB) ---

/**
 * A package definition: what the manifest SAYS, never what a catalog lookup
 * derived from it.
 *
 * Do not add derived projections (resolved skills, spawned integrations…)
 * here: version resolution swaps `manifest`/`prompt` between draft and
 * published snapshots, and anything derived would silently keep describing
 * the other definition. Derive at the point of use from the effective
 * manifest — see `resolveDeclaredSkills` in `services/package-catalog.ts`.
 */
export interface LoadedPackage {
  id: string;
  manifest: AgentManifest;
  prompt: string;
  source: "system" | "local";
  updatedAt?: Date;
}

// Hono context env — shared across all routers
export type AppEnv = {
  Variables: {
    user: { id: string; email: string; name: string };
    endUser?: import("@appstrate/core/module").EndUserContext;
    package: LoadedPackage;
    orgId: string;
    orgSlug: string;
    orgName: string;
    orgRole: import("@appstrate/shared-types").OrgRole;
    /**
     * Org-level effective set, written once the org role is known (RBAC spec
     * §4.2). Kept beside `permissions` because `requireSpaceContext` needs the
     * org half again to union the space half onto it.
     */
    orgPermissions?: Set<string>;
    /**
     * Credential ceiling: an API key's `scopes`, an OIDC scope claim, whatever
     * a module strategy computed. `undefined` for cookie sessions, which have
     * no ceiling. Every write of `permissions` intersects with it.
     */
    scopeCeiling?: ReadonlySet<string>;
    /**
     * Effective permissions for this request: `ceiling(orgPermissions)` on an
     * org route, `ceiling(orgPermissions ∪ spacePermissions)` once
     * `requireSpaceContext` has resolved the space. The only thing every
     * permission guard reads.
     */
    permissions?: Set<string>;
    /** Role the caller holds in `space`, set by `applySpacePermissions`. */
    spaceRole?: import("../lib/space-role.ts").SpaceRoleRef;
    /**
     * Per-request memo of `callerReachableSpaces`, keyed by organization and
     * role: a list spanning spaces and the package reach behind it read one
     * resolution. Owned by `lib/reachable-spaces.ts`; nothing else writes it.
     */
    reachableSpacesCache?: Map<
      string,
      Promise<import("../lib/reachable-spaces.ts").ReachableSpace[]>
    >;
    /**
     * Validated role preview: the persona whose reach answers this request
     * instead of the caller's own (`lib/view-as.ts`), set before any
     * `permissions` write. `user` and `orgRole` stay REAL — a persona restricts
     * what they reach, never who they are.
     */
    viewAs?: import("../lib/view-as.ts").ViewAsPersona;
    /**
     * Auth method that resolved the request. Core values: `"session"`,
     * `"api_key"`. Auth-strategy modules set their own identifier (e.g.
     * `"oidc"`, `"mtls"`).
     */
    authMethod: string;
    /** Declared by the strategy, or by core for its two paths — see `PrincipalKind`. */
    principalKind: import("@appstrate/core/module").PrincipalKind;
    apiKeyId: string | null;
    spaceId: string; // from API key auth or resolved by space-context middleware (X-Space-Id)
    /** The space the credential itself pins (API key, strategy); `X-Space-Id` never sets it. */
    credentialSpaceId?: string;
    /**
     * The spaces a credential bound to a SET reaches (`AuthResolution.spaceIds`): the reach is
     * cut to them and a request acts in one of them. Absent for a credential bound to none.
     */
    credentialSpaceIds?: readonly string[];
    /** Set to `false` when `credentialSpaceIds` is not a restriction the person chose (`AuthResolution.spaceIdsRestricted`). */
    credentialSpaceIdsRestricted?: false;
    /**
     * The space the endpoint itself pins (the space-pinned MCP endpoint), whatever the
     * credential reaches: the reach is cut to it like a pinned dispatch's.
     */
    endpointSpaceId?: string;
    /**
     * Resolved space row (id/orgId/isDefault) set by
     * `requireSpaceContext()` alongside `spaceId`. Services called from
     * space-scoped routes should accept this shape directly instead of taking
     * a `spaceId` string and re-SELECTing the row. Optional because
     * auth strategies set `spaceId` before the middleware runs, but
     * the `space` row is only loaded once the middleware executes.
     */
    space?: import("../lib/space-lookup.ts").SpaceContextRow;
    requestId: string;
    apiVersion: string;
    /**
     * Org settings JSONB loaded by `requireOrgContext()` in the same query
     * as the membership check, so per-request consumers (API-version
     * middleware) read settings from context instead of issuing a second
     * organizations query. Absent when org context was resolved inline by
     * non-session auth (API key, module strategies) or skipped entirely —
     * consumers must fall back to `getOrgSettings()` in that case. The stored document only:
     * its `personal_space_role` never names a custom default (`getOrgSettings` reads that).
     */
    orgSettings?: StoredOrgSettings;
    /** Set by auth strategies that defer org resolution to X-Org-Id middleware. */
    deferOrgResolution?: boolean;
    /**
     * Opaque strategy-specific metadata propagated from `AuthResolution.extra`.
     * The OIDC strategy stamps `cliFamilyId` here when resolving a CLI
     * Bearer; route handlers cast to the shape they expect.
     */
    authExtra?: Record<string, unknown>;
    /**
     * Set by an auth strategy that declared `AuthResolution.serverMinted` — a
     * server-minted, process-local bearer, carrying no CSRF risk. The credential
     * proxy's bearer-only gate reads it. See `apps/api/src/lib/bearer-only.ts`.
     */
    serverMinted?: boolean;
    /**
     * Set by an auth strategy that declared `AuthResolution.firstPartyLoopback`
     * — the chat's inference bearer. The LLM proxy's bearer-only gate, its chat
     * usage context and the models route read this declared capability instead
     * of special-casing a module's auth-method id. See
     * `apps/api/src/lib/bearer-only.ts`.
     */
    firstPartyLoopback?: boolean;
    /**
     * Realm captured from the BA session row (or user row) at auth time.
     * `"platform"` for platform audiences (default, dashboard, org/instance
     * OIDC clients); `"end_user:<spaceId>"` for end-users of an
     * space-level OIDC client. Consumed by `requirePlatformRealm()`
     * to reject BA cookie sessions that belong to a non-platform audience
     * when hitting platform routes.
     */
    sessionRealm?: string;
    /**
     * Populated by `verifyRunSignature` on HMAC-authenticated event routes
     * (POST /api/runs/:id/events and /finalize). Routes read this
     * instead of `user`/`orgId` — the principal is the run itself.
     */
    run?: import("./run-sink.ts").RunSinkContext;
    /** Request-specific webhook-id header (Standard Webhooks msg id) used for replay dedup. */
    webhookId?: string;
    /**
     * W3C Trace Context — populated by `requestId()` middleware from the
     * inbound `traceparent` header. Validated and normalised: malformed
     * headers are dropped (the middleware leaves the field undefined).
     * Routes that emit structured logs include this in the binding so
     * runs can be correlated end-to-end across services.
     */
    traceparent?: string;
    /** Trace-id portion of {@link traceparent}, exposed for cheap log binding. */
    traceId?: string;
  };
};
