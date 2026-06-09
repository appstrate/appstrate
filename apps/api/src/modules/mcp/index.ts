// SPDX-License-Identifier: Apache-2.0

/**
 * MCP module — exposes the platform REST API as an inbound MCP server, ONCE PER
 * ORGANIZATION.
 *
 * Mounts `/api/mcp/o/:org` (Streamable HTTP) plus per-org RFC 9728 discovery.
 * The ~250 platform operations are surfaced through three progressive-disclosure
 * tools (`search_operations`, `describe_operation`, `invoke_operation`) rather
 * than one tool per endpoint, keeping the client tool budget tiny. Tool calls
 * dispatch in-process through the platform app, reusing the auth pipeline and
 * RBAC — an MCP caller can do exactly what the same credential can do over REST.
 *
 * A token is RFC 8707 audience-bound to one org's resource URI
 * (`${APP_URL}/api/mcp/o/<orgId>`), confining it to that organization. The AS
 * only mints such a token if the URI is in its `validAudiences` allowlist, so
 * this module owns an org-aware allowlist (`./audiences.ts`) that is seeded from
 * the `organizations` table at boot and kept live via the `onOrgCreate` /
 * `onOrgDelete` events below.
 *
 * Consumers: external MCP clients (Claude Code, Cursor) via OAuth, the
 * first-party chat app (BFF reuses its OIDC token), and Appstrate agents.
 */

import type { AppstrateModule } from "@appstrate/core/module";
import { db } from "@appstrate/db/client";
import { organizations } from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "../../lib/logger.ts";
import { createMcpRouter } from "./router.ts";
import { mcpPaths } from "./openapi/paths.ts";
import { seedMcpOrgAudiences, addMcpOrgAudience, removeMcpOrgAudience } from "./audiences.ts";

// Cross-replica convergence interval for the org-aware audience allowlist. The
// `onOrgCreate` / `onOrgDelete` events are in-process broadcasts, so a replica
// that did not handle an org mutation would never learn it; a periodic re-seed
// from the DB bounds that staleness. The window is fail-closed in BOTH
// directions: on a lagging replica an unseeded org's mint 400s AND an
// already-minted per-org token 401s at verify (its `aud` is not yet in that
// replica's `getEndUserVerifyAudiences()` list) — never the reverse, so
// staleness can only reject legitimate traffic, never accept illegitimate. Both
// self-heal at the next re-seed. Mirrors the per-process TTL the OAuth client
// cache uses (`oauth-admin.ts`). 60s is well under any human "I created an org,
// why can't my second replica mint?" threshold.
const MCP_AUDIENCE_RESEED_INTERVAL_MS = 60_000;
let reseedTimer: ReturnType<typeof setInterval> | null = null;

/** Replace the org audience set with the current `organizations` roster. */
async function reseedMcpOrgAudiences(): Promise<void> {
  const rows = await db.select({ id: organizations.id }).from(organizations);
  seedMcpOrgAudiences(rows.map((r) => r.id));
}

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

  // Seed the org-aware RFC 8707 audience allowlist from the organizations
  // table so every existing org's per-org MCP resource URI is mintable
  // immediately at boot (no restart needed when an org pre-dates this module).
  // The set is then kept live locally by the `onOrgCreate` / `onOrgDelete`
  // events and converged across replicas by a periodic re-seed. The operation
  // catalog is built lazily on first request (after all modules have
  // contributed their paths).
  async init() {
    await reseedMcpOrgAudiences();
    // Singleton timer (the module object is a process-wide singleton, but
    // `init()` may run more than once under the test harness) — unref'd so it
    // never keeps the process alive at shutdown / between test runs.
    if (!reseedTimer) {
      reseedTimer = setInterval(() => {
        reseedMcpOrgAudiences().catch((err) => {
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

  // RFC 9728 metadata is public discovery — no auth. Only the per-org
  // path-insertion variant (RFC 9728 §3.1) is served:
  // `/.well-known/oauth-protected-resource/api/mcp/o/:org`. There is no bare
  // well-known — no single generic resource.
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

  // RBAC contribution. `mcp:read` (search/describe + reach the endpoint) is
  // broad — every role including viewer; `mcp:invoke` (execute an operation)
  // excludes viewer. Both are API-key- and end-user-grantable: headless agents
  // and embedding apps are first-class consumers. Defence in depth — the
  // dispatched operation still enforces its own permission, so `mcp:invoke`
  // can never exceed the caller's other grants.
  permissionsContribution: () => [
    {
      resource: "mcp",
      actions: ["read"],
      grantTo: ["owner", "admin", "member", "viewer"],
      apiKeyGrantable: true,
      endUserGrantable: true,
    },
    {
      resource: "mcp",
      actions: ["invoke"],
      grantTo: ["owner", "admin", "member"],
      apiKeyGrantable: true,
      endUserGrantable: true,
    },
  ],

  // Keep the org-aware RFC 8707 audience allowlist live without a restart. A
  // new org's per-org MCP resource URI must be mintable by the AS the moment the
  // org exists. `onOrgDelete` is hygiene, NOT the confinement boundary: it stops
  // re-minting a deleted org's URI and trims the verifier list, but a still-live
  // token for a deleted org is already inert — the live membership join in
  // org-context (org delete cascades the member rows) 403s it with zero
  // staleness, independent of this allowlist. The boot seed in `init()` covers
  // orgs that pre-date a restart; these events cover orgs created/deleted while
  // running. Both calls are idempotent.
  events: {
    onOrgCreate: (orgId: string) => {
      addMcpOrgAudience(orgId);
    },
    onOrgDelete: (orgId: string) => {
      removeMcpOrgAudience(orgId);
    },
  },
};

export default mcpModule;
