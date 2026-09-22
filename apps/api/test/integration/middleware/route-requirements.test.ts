// SPDX-License-Identifier: Apache-2.0

/**
 * Conformance gate: the permission the MCP surface shows for an operation is
 * the permission the route enforces. Catalog from the OpenAPI document,
 * requirement from Hono's route table; an operationId whose route the reader
 * cannot find falls back to "no requirement" — indistinguishable from
 * "public". Same read as `agent-lookup-permission-order.test.ts`: a property
 * of WHERE a middleware is mounted, invisible at runtime and in a diff.
 */

import { describe, it, expect } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { setPlatformApp } from "../../../src/lib/platform-app.ts";
import { routeRequirementKey } from "../../../src/lib/route-requirements.ts";
import {
  getCatalog,
  operationRequirement,
  type CatalogOperation,
} from "../../../src/modules/mcp/catalog.ts";

setPlatformApp(getTestApp());

/** The route-table key the catalog joins on, for a failure message. */
function key(op: CatalogOperation): string {
  return routeRequirementKey(op.method, op.pathTemplate);
}

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

  // ── Authority is a row, known only in the handler: not a mounted guard.
  {
    path: "/api/admin/storage-deletion-jobs/*",
    why: "platform-operator surface (`requirePlatformAdmin`), outside org RBAC",
  },
  { path: "/api/files/{id}*", why: "`files:delete` OR the file's own creator (`getFileForActor`)" },
  {
    path: "/api/packages/{scope}/{name}/home",
    why: "authority is the package's home space (`assertPackageMutationAccess`)",
  },
  {
    path: "/api/packages/{scope}/{name}/shares*",
    why: "authority is the package's home space (`assertPackageShareAccess`)",
  },
  {
    path: "/api/spaces/{spaceId}/packages*",
    why: "placement reads the package's share row (`gateSpacePackageWrite`)",
  },
  // The collection `POST /api/webhooks` is guarded and stays out of this list.
  { path: "/api/webhooks/{id}*", why: "per-row authority (`loadWebhookForAction`)" },
];

/** True when `pathTemplate` is covered by `list`. */
function covers(list: ReadonlyArray<{ path: string }>, pathTemplate: string): boolean {
  return list.some(({ path }) =>
    path.endsWith("*") ? pathTemplate.startsWith(path.slice(0, -1)) : pathTemplate === path,
  );
}

/** The catalog operation `operationId`, or a failure naming it. */
function op(operationId: string): CatalogOperation {
  const found = getCatalog().operations.get(operationId);
  if (!found) throw new Error(`operation \`${operationId}\` is absent from the catalog`);
  return found;
}

describe("every catalog operation joins onto a route", () => {
  it("resolves a requirement for every operation, with no exception", () => {
    const unresolved: string[] = [];
    let resolved = 0;
    for (const operation of getCatalog().operations.values()) {
      try {
        operationRequirement(operation);
        resolved += 1;
      } catch {
        unresolved.push(`${operation.operationId} (${key(operation)})`);
      }
    }
    expect(unresolved).toEqual([]); // Names, not a count.
    // Control: a wholesale break would catch everything and still list none.
    expect(resolved).toBeGreaterThan(100);
  });
});

describe("every mutating /api/ operation has a readable requirement", () => {
  it("names a permission, defers to the row, or is allowlisted", () => {
    const offenders: string[] = [];
    for (const operation of getCatalog().operations.values()) {
      if (operation.method === "GET") continue;
      if (!operation.pathTemplate.startsWith("/api/")) continue;
      if (covers(NO_MOUNTED_GUARD, operation.pathTemplate)) continue;
      const requirement = operationRequirement(operation);
      if (requirement.requirements.length === 0 && !requirement.conditional) {
        offenders.push(`${operation.operationId} (${key(operation)})`);
      }
    }
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
});

describe("requirement anchors", () => {
  it("reads `runInline` as agents:write AND agents:run — two entries", () => {
    // Collapsed into one entry it would read as a disjunction and show the
    // tool to a caller holding either half.
    expect(operationRequirement(op("runInline")).requirements).toEqual([
      "agents:write",
      "agents:run",
    ]);
  });

  it("reads `runAgent` as agents:run", () => {
    expect(operationRequirement(op("runAgent")).requirements).toEqual(["agents:run"]);
  });

  it("reads the credential proxy's `router.all` mount as credential-proxy:call", () => {
    // Four operations share one method-agnostic entry; a reader matching only
    // concrete methods would leave all four looking public.
    expect(operationRequirement(op("credentialProxyPost")).requirements).toEqual([
      "credential-proxy:call",
    ]);
  });

  it("reads the runs-read disjunction as ONE entry", () => {
    // Two entries would mean "both", hiding every run listing from a principal
    // holding only `runs:read`.
    expect(operationRequirement(op("listRuns")).requirements).toEqual(["runs:read|runs:read-all"]);
  });
});
