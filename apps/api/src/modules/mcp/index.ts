// SPDX-License-Identifier: Apache-2.0

/**
 * MCP module — exposes the platform REST API as an inbound MCP server, ONCE PER
 * ORGANIZATION.
 *
 * Mounts `/api/mcp/o/:org` (Streamable HTTP) plus per-org RFC 9728 discovery.
 * The ~250 platform operations are surfaced through three progressive-disclosure
 * tools (`search_operations`, `describe_operation`, `invoke_operation`) rather
 * than one tool per endpoint, keeping the client tool budget tiny. Run launch
 * and waiting use the dedicated `run_and_wait` shortcut. Tool calls dispatch
 * in-process through the platform app, reusing the auth pipeline and RBAC — an
 * MCP caller can do exactly what the same credential could do over REST.
 *
 * A token is RFC 8707 audience-bound to one org's resource URI
 * (`${APP_URL}/api/mcp/o/<orgId>`), confining it to that organization. The AS
 * only mints such a token when that URI has an `oauth_resources` row, so this
 * module owns one row per org — reconciled from the `organizations` table at
 * boot and written / deleted on the `onOrgCreate` / `onOrgDelete` events below,
 * alongside the in-process verifier set in `lib/audiences.ts`.
 *
 * Consumers: external MCP clients (Claude Code, Cursor) via OAuth, the
 * first-party chat app (BFF reuses its OIDC token), and Appstrate agents.
 */

import type { AppstrateModule } from "@appstrate/core/module";
import { and, eq, like, notExists, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { organizations, oauthResource } from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "../../lib/logger.ts";
import { createMcpRouter } from "./router.ts";
import { mcpPaths } from "./openapi/paths.ts";
import {
  getMcpOrgResourceUri,
  setMcpOrgVerifyAudiences,
  addMcpOrgVerifyAudience,
  removeMcpOrgVerifyAudience,
} from "../../lib/audiences.ts";

// Cross-replica convergence interval, for the VERIFIER set — the per-process
// in-memory half (`lib/audiences.ts`). A replica that misses an `onOrgCreate`
// broadcast 401s an already-minted per-org token because its `aud` is not in
// that replica's `getEndUserVerifyAudiences()` list. The window is fail-closed
// — staleness can only reject legitimate traffic, never accept illegitimate —
// and self-heals at the next tick. Minting does not depend on the tick: the AS
// resolves a requested `resource` against the shared `oauth_resources` table on
// every token call, so a row written by one replica is mintable from all of
// them at once. The tick reuses the SAME reconcile as `init()`, so a row write
// dropped by a transient DB error on the event path self-heals too. Mirrors the
// per-process TTL the OAuth client cache uses (`oauth-admin.ts`); 60s is well
// under any human "I created an org, why does my second replica 401?" threshold.
const MCP_AUDIENCE_RESEED_INTERVAL_MS = 60_000;
let reseedTimer: ReturnType<typeof setInterval> | null = null;

/** The `oauth_resources` row backing one org's per-org MCP endpoint. */
function mcpOrgResourceRow(orgId: string) {
  return {
    id: crypto.randomUUID(),
    identifier: getMcpOrgResourceUri(orgId),
    name: `MCP endpoint for organization ${orgId}`,
  };
}

/**
 * Reconcile both halves of the per-org RFC 8707 audience model with the current
 * `organizations` roster: the durable, cross-replica MINT rows and this
 * process's VERIFIER set. Symmetric — one statement per direction, so a lost
 * `onOrgCreate` and a lost `onOrgDelete` both converge here. Idempotent.
 *
 * The delete names no roster: its `NOT EXISTS` is evaluated by Postgres against
 * the live `organizations` table, so "is this row's org gone?" is answered at
 * the instant of the delete rather than by a list read earlier. An org that
 * commits while this function runs is therefore never swept — and since
 * `onOrgCreate` writes its `oauth_resources` row only after the org row is
 * committed, any row this statement can see belongs to an org it can see too.
 * The roster read below feeds the verifier set and the insert, which are
 * additive: seeing a stale roster costs one tick of convergence, never a
 * deletion.
 */
async function reconcileMcpOrgAudiences(): Promise<void> {
  const rows = await db.select({ id: organizations.id }).from(organizations);
  setMcpOrgVerifyAudiences(rows.map((r) => r.id));
  // Only per-org URIs are ours to drop: the two static platform identifiers the
  // AS seeds sit outside this prefix. `_` and `%` are LIKE wildcards, so an
  // APP_URL carrying either would over-match — escape them (Postgres' default
  // LIKE escape is the backslash).
  const prefix = getMcpOrgResourceUri("");
  const prefixPattern = `${prefix.replace(/([\\%_])/g, "\\$1")}%`;
  await db.delete(oauthResource).where(
    and(
      like(oauthResource.identifier, prefixPattern),
      notExists(
        db
          .select({ live: sql`1` })
          .from(organizations)
          .where(eq(oauthResource.identifier, sql`${prefix} || ${organizations.id}`)),
      ),
    ),
  );
  if (rows.length === 0) return;
  await db
    .insert(oauthResource)
    .values(rows.map((r) => mcpOrgResourceRow(r.id)))
    .onConflictDoNothing({ target: oauthResource.identifier });
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

  // Reconcile the per-org RFC 8707 audience model with the organizations table
  // so every existing org's per-org MCP resource URI is mintable immediately at
  // boot (no restart needed when an org pre-dates this module). It is then kept
  // live by the `onOrgCreate` / `onOrgDelete` events and converged across
  // replicas by the periodic tick. The operation catalog is built lazily on
  // first request (after all modules have contributed their paths).
  async init() {
    await reconcileMcpOrgAudiences();
    // Singleton timer (the module object is a process-wide singleton, but
    // `init()` may run more than once under the test harness) — unref'd so it
    // never keeps the process alive at shutdown / between test runs.
    if (!reseedTimer) {
      reseedTimer = setInterval(() => {
        reconcileMcpOrgAudiences().catch((err) => {
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

  // RBAC contribution. The endpoint dispatches space-scoped platform
  // operations, so `mcp` is a space-level resource. `mcp:read`
  // (search/describe + reach the endpoint) is broad — every preset including
  // viewer; `mcp:invoke` (execute an operation) excludes viewer. Both are
  // API-key- and end-user-grantable: headless agents and embedding apps are
  // first-class consumers. Defence in depth — the dispatched operation still
  // enforces its own permission, so `mcp:invoke` can never exceed the
  // caller's other grants.
  permissionsContribution: () => [
    {
      resource: "mcp",
      actions: ["read"],
      level: "space",
      presets: ["admin", "builder", "operator", "viewer"],
      apiKeyGrantable: true,
      endUserGrantable: true,
    },
    {
      resource: "mcp",
      actions: ["invoke"],
      level: "space",
      presets: ["admin", "builder", "operator"],
      apiKeyGrantable: true,
      endUserGrantable: true,
    },
  ],

  // Keep the per-org RFC 8707 audience model live without a restart. A new org's
  // per-org MCP resource URI must be mintable by the AS the moment the org
  // exists. `onOrgDelete` is hygiene, NOT the confinement boundary: it stops
  // re-minting a deleted org's URI and trims the verifier set, but a still-live
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
      await db
        .delete(oauthResource)
        .where(eq(oauthResource.identifier, getMcpOrgResourceUri(orgId)));
    },
  },
};

export default mcpModule;
