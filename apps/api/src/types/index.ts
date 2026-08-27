// SPDX-License-Identifier: Apache-2.0

// Only re-export types actually imported through this path (backend-only consumers).
// All other shared types should be imported directly from "@appstrate/shared-types".
export type { OrgRole } from "@appstrate/shared-types";

// --- Agent Manifest Types ---
// Re-exported from @appstrate/validation. The AgentManifest type is Zod-inferred
// and covers all agent manifest fields (name, version, type, dependencies, input/output, timeout).

import type { AgentManifest } from "@appstrate/core/validation";
export type { AgentManifest };

// --- Loaded Package (manifest + prompt from DB) ---

/**
 * A package definition: what the manifest SAYS, never what a catalog lookup
 * derived from it.
 *
 * Do not add derived projections (resolved skills, spawned integrations…)
 * here: version resolution swaps `manifest`/`prompt` between draft and
 * published snapshots, and anything derived would silently keep describing
 * the other definition (#878). Derive at the point of use from the effective
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
    permissions?: Set<string>;
    /**
     * Auth method that resolved the request. Core values: `"session"`,
     * `"api_key"`. Auth-strategy modules set their own identifier (e.g.
     * `"oidc"`, `"mtls"`).
     */
    authMethod: string;
    apiKeyId: string | null;
    spaceId: string; // from API key auth or resolved by space-context middleware (X-Space-Id)
    /**
     * Resolved space row (id/orgId/isDefault) set by
     * `requireSpaceContext()` alongside `spaceId`. Services called from
     * space-scoped routes should accept this shape directly instead of taking
     * a `spaceId` string and re-SELECTing the row. Optional because
     * auth strategies set `spaceId` before the middleware runs, but
     * the `space` row is only loaded once the middleware executes.
     */
    space?: import("../middleware/space-context.ts").SpaceContextRow;
    requestId: string;
    apiVersion: string;
    /**
     * Org settings JSONB loaded by `requireOrgContext()` in the same query
     * as the membership check, so per-request consumers (API-version
     * middleware) read settings from context instead of issuing a second
     * organizations query. Absent when org context was resolved inline by
     * non-session auth (API key, module strategies) or skipped entirely —
     * consumers must fall back to `getOrgSettings()` in that case.
     */
    orgSettings?: import("@appstrate/shared-types").OrgSettings;
    /** Set by auth strategies that defer org resolution to X-Org-Id middleware. */
    deferOrgResolution?: boolean;
    /**
     * Opaque strategy-specific metadata propagated from `AuthResolution.extra`.
     * The OIDC strategy stamps `cliFamilyId` here when resolving a CLI
     * Bearer; route handlers cast to the shape they expect.
     */
    authExtra?: Record<string, unknown>;
    /**
     * Set by an auth strategy that declared `AuthResolution.firstPartyLoopback`
     * — a server-minted, process-local loopback bearer. The bearer-only proxy
     * gate (`assertBearerOnly`) and the models route read this declared
     * capability instead of special-casing a module's auth-method id. See
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
     * (POST /api/runs/:runId/events and /finalize). Routes read this
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
