// SPDX-License-Identifier: Apache-2.0

/**
 * The catalog's join from an operationId onto the permission its route
 * enforces: every documented operation resolves one, every mutating one is
 * readable (a permission, a row-authoritative marker, or an allowlist entry
 * that still stands for something), and an operation no route serves refuses
 * to build rather than publish as public. Reads the catalog only — no DB.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { registerTestPlatformApp } from "../../../../../test/helpers/platform-app.ts";
import { getPlatformRoutes, setPlatformApp } from "../../../../lib/platform-app.ts";
import { deriveRouteRequirements } from "../../../../lib/route-requirements.ts";
import { getCatalog, resetCatalog, type CatalogOperation } from "../../catalog.ts";
import type { AppEnv } from "../../../../types/index.ts";

await registerTestPlatformApp();

/** The route-table key the catalog joins on, for a failure message. */
function key(op: CatalogOperation): string {
  return `${op.method} ${op.pathTemplate}`;
}

/** The catalog operation `operationId`, or a failure naming it. */
function op(operationId: string): CatalogOperation {
  const found = getCatalog().operations.get(operationId);
  if (!found) throw new Error(`operation \`${operationId}\` is absent from the catalog`);
  return found;
}

describe("getCatalog — the route join", () => {
  beforeEach(() => resetCatalog());

  it("resolves a requirement for every operation, with no exception", () => {
    // Building the catalog at all is the assertion: one unjoined operation and
    // the call throws, naming it. The control is that it joined a real surface
    // rather than an empty one.
    expect(getCatalog().operations.size).toBeGreaterThan(100);
  });

  it("refuses to build when a documented operation has no mounted route", async () => {
    // The refusal is the whole point of the join: an operation the route table
    // cannot find would otherwise be published as needing nothing.
    const bare = new Hono<AppEnv>();
    bare.get("/api/health", (c) => c.json({ ok: true }));
    setPlatformApp(bare);
    resetCatalog();
    try {
      expect(() => getCatalog()).toThrow(/no mounted route serves/);
      // Naming the unserved operations is what makes the failure actionable.
      const message = (() => {
        try {
          getCatalog();
          return "";
        } catch (error) {
          return (error as Error).message;
        }
      })();
      expect(message).toContain("createSpace");
    } finally {
      await registerTestPlatformApp();
      resetCatalog();
    }
  });

  it("reads the guard mounted on a real operation's route", () => {
    const runAgent = getCatalog().operations.get("runAgent");
    expect(runAgent).toBeDefined();
    expect(runAgent!.requirement.requirements).toContain("agents:run");
  });

  it("resolves the prefix-mounted Better Auth family too", () => {
    const signIn = getCatalog().operations.get("signInEmail");
    expect(signIn).toBeDefined();
    expect(signIn!.requirement.requirements).toEqual([]);
  });
});

describe("the lookup the catalog joins on", () => {
  it("answers undefined for a template no route serves", () => {
    // What makes the join above a failure rather than a silent grant: the
    // lookup reports "nothing serves this", and `getCatalog()` refuses to build.
    const requirementFor = deriveRouteRequirements(getPlatformRoutes());
    expect(requirementFor("POST", "/api/nothing-mounts-this/{id}")).toBeUndefined();
  });
});

/**
 * The permission the MCP surface shows for an operation must be the permission
 * its route enforces. A mutating operation therefore names a permission, says
 * the row decides (`rowAuthority()`), or appears in the allowlist below with
 * the authority that stands in for a mounted guard. Both directions are gates:
 * an operation that fits none of the three fails, and so does an allowlist
 * entry whose reason expired — nothing else would ever delete it.
 */

/**
 * Non-`GET` `/api/` operations that mount no permission guard, each with the
 * authority that stands in for one. `*` covers the subtree, anything else
 * matches exactly. An entry whose reason stops being true is deleted.
 */
const NO_MOUNTED_GUARD: ReadonlyArray<{ path: string; why: string }> = [
  // ── The request's own token is the authority — no principal to check.
  { path: "/api/auth/*", why: "runs before a principal exists; the token IS the credential" },
  {
    path: "/api/integrations/connect/submit",
    why: "hosted connect portal — the page cookie and its CSRF nonce carry the authority",
  },
  {
    path: "/api/model-providers-oauth/pair/redeem",
    why: "the one-shot pairing token minted for `npx @appstrate/connect-helper`",
  },
  { path: "/api/runs/{runId}/events*", why: "runner ingestion — HMAC `verifyRunSignature`" },
  // NOT `/api/runs/{runId}*`: `sink/extend` carries `agents:run`.
  { path: "/api/runs/{runId}/files", why: "runner upload — HMAC `verifyRunUploadSignature`" },
  { path: "/api/uploads/_content", why: "HMAC upload sink — skips the auth pipeline outright" },
  // Present only when `@appstrate/module-ee` is loaded — the preload discovers
  // `packages/module-*` on Postgres tiers, never on tier 0 — so a run without
  // EE never judges this entry at all.
  { path: "/api/billing/webhooks", why: "Stripe receiver, verified by `stripe-signature`" },

  // ── Self-scoped: the caller's own rows, with no RBAC resource to name.
  { path: "/api/me/*", why: "filtered by the caller's own identity, never by a grant" },
  { path: "/api/profile", why: "the person's own account (`isUserPrincipal`)" },
  { path: "/api/profile/password", why: "the person's own account (`isUserPrincipal`)" },
  // Two exact entries: `/api/profiles/batch` carries `members:read`.
  { path: "/api/notifications/*", why: "someone else's notification is a 404, not a 403" },
  { path: "/api/uploads", why: "mints an upload token into the caller's own space, nothing else" },
  { path: "/api/welcome/setup", why: "onboarding, on the person's own credential only" },
  // Exact: everything under `/api/orgs/…` IS guarded.
  { path: "/api/orgs", why: "creating an org happens outside org context — no role to check" },

  // ── Platform-operator authority, outside org RBAC entirely.
  {
    path: "/api/admin/storage-deletion-jobs/*",
    why: "platform-operator surface (`requirePlatformAdmin`), not a row and not a grant",
  },
];

/** Entries a deployment without `@appstrate/module-ee` cannot match. */
const PRESENT_ONLY_WITH_EE: ReadonlySet<string> = new Set(["/api/billing/webhooks"]);

/** True when `pathTemplate` is covered by `list`. */
function covers(list: ReadonlyArray<{ path: string }>, pathTemplate: string): boolean {
  return list.some(({ path }) =>
    path.endsWith("*") ? pathTemplate.startsWith(path.slice(0, -1)) : pathTemplate === path,
  );
}

/**
 * Mutating `/api/` operations whose route names no permission — in the caller's
 * space or in the one its path re-scopes to — and does not say the row decides.
 * Exactly what an allowlist entry has to stand for.
 */
function unguardedMutations(): CatalogOperation[] {
  return [...getCatalog().operations.values()].filter(
    (operation) =>
      operation.method !== "GET" &&
      operation.pathTemplate.startsWith("/api/") &&
      operation.requirement.requirements.length === 0 &&
      operation.requirement.targetSpaceRequirements.length === 0 &&
      !operation.requirement.conditional,
  );
}

describe("every mutating /api/ operation has a readable requirement", () => {
  it("names a permission, defers to the row, or is allowlisted", () => {
    const offenders = unguardedMutations()
      .filter((operation) => !covers(NO_MOUNTED_GUARD, operation.pathTemplate))
      .map((operation) => `${operation.operationId} (${key(operation)})`);
    expect(offenders).toEqual([]);
  });

  it("still has mutating operations to judge", () => {
    // Control for the loop above: a filter excluding everything would pass it.
    const judged = [...getCatalog().operations.values()].filter(
      (operation) =>
        operation.method !== "GET" &&
        operation.pathTemplate.startsWith("/api/") &&
        !covers(NO_MOUNTED_GUARD, operation.pathTemplate),
    );
    expect(judged.length).toBeGreaterThan(80);
  });

  it("carries no allowlist entry that has stopped standing for anything", () => {
    // The other direction: a route that gained a guard (or a `rowAuthority()`
    // marker) leaves its entry matching nothing, and an entry matching nothing
    // is a permanent excuse for whatever is mounted there next.
    const unguarded = unguardedMutations();
    const stale = NO_MOUNTED_GUARD.filter(
      (entry) =>
        !PRESENT_ONLY_WITH_EE.has(entry.path) &&
        !unguarded.some((operation) => covers([entry], operation.pathTemplate)),
    ).map((entry) => entry.path);
    expect(stale).toEqual([]);
  });
});

describe("requirement anchors", () => {
  it("reads every row-authoritative route as conditional", () => {
    // Each of these refuses from a row its handler loads — a file's ACL, the
    // package's home space, the webhook's own space, the placement, the
    // registry agent's placement and activation — behind no guard that could
    // state the string. Read as unconditional they would show in the MCP
    // surface as granted to anyone who reached the transport.
    const unconditional = [
      "deleteFile",
      "keepFile",
      "movePackageHome",
      "sharePackage",
      "listPackageShares",
      "revokePackageShare",
      "updateWebhook",
      "activatePackage",
      "updateSpacePackage",
      "deactivatePackage",
      "createRemoteRun",
      "exportAgentBundle",
    ].filter((operationId) => !op(operationId).requirement.conditional);
    expect(unconditional).toEqual([]);

    // The control: a route whose guard IS the whole answer stays unconditional,
    // so the assertion above is the markers and not a flag stuck on.
    expect(op("createSpace").requirement).toMatchObject({
      requirements: ["spaces:write"],
      conditional: false,
    });
  });

  it("reads `listSpaceMembers` as a requirement of the space the PATH names", () => {
    // `requireSpaceFromParam` re-applies the caller's permissions in that space
    // before the guard runs, so `space-members:read` is asked THERE. Reported
    // as a caller-space requirement it would hide the operation from everyone
    // whose current space is not the one they are asking about — which is the
    // normal case for an org-wide client.
    const requirement = op("listSpaceMembers").requirement;
    expect(requirement.requirements).toEqual([]);
    expect(requirement.targetSpaceRequirements).toContain("space-members:read");

    // The control: the same guard mounted WITHOUT a re-scope in front of it is
    // a caller-space requirement, so the split above is the marker's doing.
    expect(op("listApiKeys").requirement).toMatchObject({
      requirements: ["api-keys:read"],
      targetSpaceRequirements: [],
    });
  });
});
