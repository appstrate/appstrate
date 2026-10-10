// SPDX-License-Identifier: Apache-2.0

/**
 * MCP module — exposes the platform REST API as an inbound MCP server, ONCE PER
 * ORGANIZATION.
 *
 * Mounts `/api/mcp/o/:org` and the space-pinned `/api/mcp/o/:org/s/:space`
 * (Streamable HTTP), each with its own RFC 9728 discovery.
 * The ~250 platform operations are surfaced through three progressive-disclosure
 * tools (`search_operations`, `describe_operation`, `invoke_operation`) rather
 * than one tool per endpoint, keeping the client tool budget tiny. Run launch
 * and waiting use the dedicated `run_and_wait` shortcut. Tool calls dispatch
 * in-process through the platform app, reusing the auth pipeline and RBAC — an
 * MCP caller can do exactly what the same credential could do over REST.
 *
 * A token is RFC 8707 audience-bound to one MCP resource URI — an org's
 * (`${APP_URL}/api/mcp/o/<orgId>`) or one of its spaces'
 * (`…/o/<orgId>/s/<spaceId>`) — confining it to that organization or space.
 * The AS only mints such a token when that URI has an `oauth_resources` row, so
 * this module owns them (`./oauth-resources.ts`): one row per org, reconciled
 * from the `organizations` table at boot and written / deleted on the
 * `onOrgCreate` / `onOrgDelete` events below, and a space's row written when
 * the AS is first asked for it — alongside the in-process verifier set in
 * `lib/audiences.ts`.
 *
 * Consumers: external MCP clients (Claude Code, Cursor) via OAuth, the
 * first-party chat app (BFF reuses its OIDC token), and Appstrate agents.
 */

import type { AppstrateModule } from "@appstrate/core/module";
import { db } from "@appstrate/db/client";
import { oauthResource } from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "../../lib/logger.ts";
import { createMcpRouter } from "./router.ts";
import { mcpPaths } from "./openapi/paths.ts";
import { addMcpOrgVerifyAudience, removeMcpOrgVerifyAudience } from "../../lib/audiences.ts";
import {
  dropMcpOrgResources,
  mcpOrgResourceRow,
  reconcileMcpAudiences,
} from "./oauth-resources.ts";

// Cross-replica convergence interval, for the VERIFIER set — the per-process
// in-memory half (`lib/audiences.ts`). A replica that misses an `onOrgCreate`
// broadcast 401s an already-minted token for that org because its `aud` is not
// accepted by that replica's `isEndUserVerifyAudience()`. The window is
// fail-closed — staleness can only reject legitimate traffic, never accept
// illegitimate — and self-heals at the next tick. Minting does not depend on the tick: the AS
// resolves a requested `resource` against the shared `oauth_resources` table on
// every token call, so a row written by one replica is mintable from all of
// them at once. The tick reuses the SAME reconcile as `init()`, so a row write
// dropped by a transient DB error on the event path self-heals too. Mirrors the
// per-process TTL the OAuth client cache uses (`oauth-admin.ts`); 60s is well
// under any human "I created an org, why does my second replica 401?" threshold.
const MCP_AUDIENCE_RESEED_INTERVAL_MS = 60_000;
let reseedTimer: ReturnType<typeof setInterval> | null = null;

// Register `mcp` as a module-owned RBAC resource. Declaration merging on
// `ModuleResources` re-enters the typed Resource union consumed by
// `requirePermission` / `requireModulePermission`, so the guards stay narrowed.
declare module "@appstrate/core/permissions" {
  interface ModuleResources {
    mcp: "read" | "invoke";
  }
}

const mcpModule: AppstrateModule = {
  manifest: { id: "mcp", name: "MCP Server", version: "1.0.0" },

  // Reconcile the RFC 8707 audience model with the organizations and spaces
  // tables so every existing org's MCP resource URI is mintable immediately at
  // boot (no restart needed when an org pre-dates this module), and the rows of
  // deleted spaces are swept. It is then kept live by the `onOrgCreate` /
  // `onOrgDelete` events and converged across replicas by the periodic tick. The operations are joined onto their routes
  // at boot by `registerPlatformApp()`; the catalog only caches its view of
  // them on first read.
  async init() {
    await reconcileMcpAudiences();
    // Singleton timer (the module object is a process-wide singleton, but
    // `init()` may run more than once under the test harness) — unref'd so it
    // never keeps the process alive at shutdown / between test runs.
    if (!reseedTimer) {
      reseedTimer = setInterval(() => {
        reconcileMcpAudiences().catch((err) => {
          logger.warn("mcp: periodic audience re-seed failed", {
            module: "mcp",
            error: getErrorMessage(err),
          });
        });
      }, MCP_AUDIENCE_RESEED_INTERVAL_MS);
      reseedTimer.unref?.();
    }
  },

  createRouter() {
    return createMcpRouter();
  },

  // RFC 9728 metadata is public discovery — no auth. Only the path-insertion
  // variants (RFC 9728 §3.1) are served:
  // `/.well-known/oauth-protected-resource/api/mcp/o/:org` and its `/s/:space`
  // form. There is no bare well-known — no single generic resource.
  //
  // No entry is needed here: `skipAuth` treats every path OUTSIDE `/api/*` as
  // public, and the well-known lives under `/.well-known/*`, so it already
  // bypasses auth. The `publicPaths` allowlist is matched by EXACT path
  // (`publicPaths.has(path)`), which could never match the `:org`-bearing path
  // anyway. Left empty so we don't imply a (non-existent) prefix match.
  publicPaths: [],

  openApiPaths() {
    return mcpPaths;
  },

  openApiTags() {
    return [{ name: "MCP", description: "Model Context Protocol server over the platform API" }];
  },

  features: { mcp: true },

  // RBAC contribution. The endpoint dispatches space-scoped platform
  // operations, so `mcp` is a space-level resource. `mcp:read`
  // (search/describe + reach the endpoint) is broad — every preset including
  // viewer; `mcp:invoke` (execute an operation) excludes viewer and reaches
  // `runner`, whose whole job is to launch through a friendly surface. Both are
  // API-key- and end-user-grantable: headless agents and embedding apps are
  // first-class consumers. Defence in depth — the dispatched operation still
  // enforces its own permission, so `mcp:invoke` can never exceed the
  // caller's other grants.
  permissionsContribution: () => [
    {
      resource: "mcp",
      actions: ["read"],
      level: "space",
      presets: ["admin", "builder", "operator", "runner", "viewer"],
      apiKeyGrantable: true,
      endUserGrantable: true,
    },
    {
      resource: "mcp",
      actions: ["invoke"],
      level: "space",
      presets: ["admin", "builder", "operator", "runner"],
      apiKeyGrantable: true,
      endUserGrantable: true,
    },
  ],

  // Keep the RFC 8707 audience model live without a restart. A new org's MCP
  // resource URI must be mintable by the AS the moment the org exists.
  // `onOrgDelete` is hygiene, NOT the confinement boundary: it stops re-minting
  // a deleted org's URIs (its own and its spaces') and trims the verifier set, but a still-live
  // token for a deleted org is already inert — the live membership join in
  // org-context (org delete cascades the member rows) 403s it with zero
  // staleness, independent of these rows. The boot reconcile covers orgs that
  // pre-date a restart; these events cover orgs created/deleted while running.
  // Every call is idempotent. `emitEvent` awaits and logs a throw here rather
  // than failing the org mutation, and the periodic reconcile repairs it.
  events: {
    onOrgCreate: async (orgId: string) => {
      addMcpOrgVerifyAudience(orgId);
      await db
        .insert(oauthResource)
        .values(mcpOrgResourceRow(orgId))
        .onConflictDoNothing({ target: oauthResource.identifier });
    },
    onOrgDelete: async (orgId: string) => {
      removeMcpOrgVerifyAudience(orgId);
      await dropMcpOrgResources(orgId);
    },
  },
};

export default mcpModule;
