// SPDX-License-Identifier: Apache-2.0

/**
 * The catalog's join from an operationId onto the permission its route
 * enforces: every documented operation resolves one, every mutating one is
 * readable (a permission, a row-authoritative marker, or an allowlist entry
 * that still stands for something), and an app leaving an operation unserved is
 * refused registration rather than publishing it as public. The surfaces with
 * no route table (core predicates, the chat capabilities, the web chip) are
 * pinned to the operations they stand for. Reads the catalog only — no DB.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { getTestApp } from "../../../helpers/app.ts";
import { registerTestPlatformApp } from "../../../helpers/platform-app.ts";
import { registerPlatformApp } from "../../../../src/lib/platform-app.ts";
import { deriveRouteRequirements } from "../../../../src/lib/route-requirements.ts";
import { isGranted } from "../../../../src/lib/route-requirements.ts";
import {
  knownSpaceLevelPermissions,
  orgPermissions,
  presetPermissions,
} from "../../../../src/lib/permissions.ts";
import {
  ORG_ROLES,
  SPACE_ROLE_PRESETS,
  canComposeInline,
  canReadRuns,
  canRunAgents,
} from "@appstrate/core/permissions";
import { reaches, turnCapabilities } from "@appstrate/module-chat/capabilities";
import { getCatalog, type CatalogOperation } from "../../../../src/modules/mcp/catalog.ts";
import type { AppEnv } from "../../../../src/types/index.ts";

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
  it("resolves a requirement for every operation, with no exception", () => {
    // Building the catalog at all is the assertion: one unjoined operation and
    // the call throws, naming it. The control is that it joined a real surface
    // rather than an empty one.
    expect(getCatalog().operations.size).toBeGreaterThan(100);
  });

  it("refuses to register an app when a documented operation has no mounted route", () => {
    // The refusal is the whole point of the join: an operation the route table
    // cannot find would otherwise be published as needing nothing.
    const bare = new Hono<AppEnv>();
    bare.get("/api/health", (c) => c.json({ ok: true }));
    expect(() => registerPlatformApp(bare)).toThrow(/no mounted route serves/);
    // Naming the unserved operations is what makes the failure actionable.
    expect(() => registerPlatformApp(bare)).toThrow("createSpace (POST /api/spaces)");
    // A refused registration leaves the previous one answering.
    expect(getCatalog().operations.size).toBeGreaterThan(100);
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
    // lookup reports "nothing serves this", and registration refuses the app.
    const requirementFor = deriveRouteRequirements(getTestApp().routes);
    expect(requirementFor("POST", "/api/nothing-mounts-this/{id}")).toBeUndefined();
  });

  it("finds no method served by middleware alone", () => {
    // An exact-path `use()` is an `ALL` mount, which serves every method: one
    // at `/api/spaces/:id` would make `PUT` exist to this lookup, unguarded.
    const requirementFor = deriveRouteRequirements(getTestApp().routes);
    expect(requirementFor("PUT", "/api/spaces/{id}")).toBeUndefined();
    // The control: the methods that route does mount still resolve.
    expect(requirementFor("GET", "/api/spaces/{id}")).toBeDefined();
  });
});

/**
 * The permission the MCP surface shows for an operation must be the permission
 * its route enforces — for a read as much as a write: an unguarded GET is
 * advertised to every caller. An operation therefore names a permission, says
 * the handler decides (`rowAuthority()`), or appears in the allowlist below with
 * the authority that stands in for a mounted guard. Both directions are gates:
 * an operation that fits none of the three fails, and so does an allowlist
 * entry whose reason expired — nothing else would ever delete it.
 */

/**
 * `/api/` operations that mount no permission guard, each with the authority
 * that stands in for one. `*` covers the subtree, anything else
 * matches exactly. An entry whose reason stops being true is deleted.
 */
const NO_MOUNTED_GUARD: ReadonlyArray<{ path: string; why: string }> = [
  // ── The request's own token is the authority — no principal to check.
  { path: "/api/auth/*", why: "runs before a principal exists; the token IS the credential" },
  {
    path: "/api/integrations/connect/*",
    why: "hosted connect portal — the signed start token, then the page cookie and its CSRF nonce",
  },
  {
    path: "/api/integrations/callback",
    why: "the provider's OAuth redirect — the PKCE `state` it echoes is the credential",
  },
  {
    path: "/api/model-providers-oauth/pair/redeem",
    why: "the one-shot pairing token minted for `npx @appstrate/connect-helper`",
  },
  { path: "/api/runs/{runId}/events*", why: "runner ingestion — HMAC `verifyRunSignature`" },
  // NOT `/api/runs/{runId}*`: `sink/extend` carries `agents:run`.
  {
    path: "/api/runs/{runId}/files*",
    why: "runner I/O — HMAC `verifyRunSignature` / `verifyRunUploadSignature`",
  },
  { path: "/api/runs/{runId}/workspace", why: "runner input — HMAC `verifyRunSignature`" },
  { path: "/api/oauth/logout", why: "ends the session its own cookie names" },
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
  { path: "/api/notifications*", why: "filtered by the caller's actor; another's is a 404" },
  { path: "/api/uploads", why: "mints an upload token into the caller's own space, nothing else" },
  { path: "/api/welcome/setup", why: "onboarding, on the person's own credential only" },
  // Exact: every other route under `/api/orgs/…` IS guarded.
  { path: "/api/orgs", why: "the caller's own orgs, listed or created outside any org context" },
  { path: "/api/orgs/{orgId}", why: "membership (`orgRole`) is the gate, and every role reads" },
  { path: "/api/orgs/{orgId}/settings", why: "membership (`orgRole`) is the gate, every role" },

  // ── No org data at all.
  {
    path: "/api/models/openrouter",
    why: "proxies OpenRouter's public model catalog, rate-limited; nothing of the org's",
  },

  // ── Platform-operator authority, outside org RBAC entirely.
  {
    path: "/api/admin/storage-deletion-jobs*",
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
 * `/api/` operations whose route names no permission — in the caller's space or
 * in the one its path re-scopes to — and does not say the handler decides.
 * Exactly what an allowlist entry has to stand for.
 */
function unguardedOperations(): CatalogOperation[] {
  return [...getCatalog().operations.values()].filter(
    (operation) =>
      operation.pathTemplate.startsWith("/api/") &&
      operation.requirement.requirements.length === 0 &&
      operation.requirement.targetSpaceRequirements.length === 0 &&
      !operation.requirement.conditional,
  );
}

describe("every /api/ operation has a readable requirement", () => {
  it("names a permission, defers to the row, or is allowlisted", () => {
    const offenders = unguardedOperations()
      .filter((operation) => !covers(NO_MOUNTED_GUARD, operation.pathTemplate))
      .map((operation) => `${operation.operationId} (${key(operation)})`);
    expect(offenders).toEqual([]);
  });

  it("still has reads and writes to judge", () => {
    // Control for the loop above: a filter excluding everything would pass it.
    const judged = [...getCatalog().operations.values()].filter(
      (operation) =>
        operation.pathTemplate.startsWith("/api/") &&
        !covers(NO_MOUNTED_GUARD, operation.pathTemplate),
    );
    expect(judged.filter((operation) => operation.method === "GET").length).toBeGreaterThan(80);
    expect(judged.filter((operation) => operation.method !== "GET").length).toBeGreaterThan(80);
  });

  it("carries no allowlist entry that has stopped standing for anything", () => {
    // The other direction: a route that gained a guard (or a `rowAuthority()`
    // marker) leaves its entry matching nothing, and an entry matching nothing
    // is a permanent excuse for whatever is mounted there next.
    const unguarded = unguardedOperations();
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
    // registry agent's placement and activation, the caller's org role on the
    // organization library — behind no guard that could
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
      "getLibrary",
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

  it("reads the OIDC per-space auth configuration as a requirement of the path's space", () => {
    // The OIDC router enters the space `:id` names before `space-settings:write`
    // runs, so an admin of that space is granted it whatever space they call from.
    const misread = [
      "getSpaceSocialProvider",
      "getSpaceSmtpConfig",
      "upsertSpaceSmtpConfig",
    ].filter((operationId) => {
      const requirement = op(operationId).requirement;
      return (
        requirement.requirements.length > 0 ||
        !requirement.targetSpaceRequirements.includes("space-settings:write")
      );
    });
    expect(misread).toEqual([]);
  });
});

/** A path naming its space right after `/api/spaces/`: `/api/spaces/{id}/…`. */
const PATH_SPACE = /^\/api\/spaces\/\{(id|spaceId)\}\//;

describe("a route addressing a space by path enforces space permissions there", () => {
  /** Catalog operations whose path names the space they act in. */
  function pathSpaceOperations(): CatalogOperation[] {
    return [...getCatalog().operations.values()].filter((operation) =>
      PATH_SPACE.test(operation.pathTemplate),
    );
  }

  it("reports no space-level permission as a caller-space requirement", () => {
    // A space-level guard on such a route is only meaningful in the path's
    // space; read as the caller's it hides the operation from an admin of the
    // target while advertising it to one of the caller's space. Its presence
    // here means the middleware entering that space is not `markSpaceRescope`d.
    const spaceLevel = knownSpaceLevelPermissions();
    const offenders = pathSpaceOperations().flatMap((operation) =>
      operation.requirement.requirements
        .filter((entry) => entry.split("|").some((alternative) => spaceLevel.has(alternative)))
        .map((entry) => `${operation.operationId} (${key(operation)}): ${entry}`),
    );
    expect(offenders).toEqual([]);
  });

  it("still has path-space operations to judge", () => {
    // Control for the loop above: a pattern matching nothing would pass it.
    expect(pathSpaceOperations().length).toBeGreaterThanOrEqual(20);
  });
});

/**
 * Surfaces with no route table decide from hand-written predicates; each must
 * answer exactly what the guard of the operation it stands for answers, over
 * every role a member can hold and the edge sets the presets never produce.
 */
describe("hand-written predicates agree with the guards they stand for", () => {
  /** Org role ∪ space preset: the effective sets a session actually carries. */
  const roleSets = ORG_ROLES.flatMap((role) =>
    SPACE_ROLE_PRESETS.map((preset): [string, ReadonlySet<string>] => [
      `${role}+${preset}`,
      new Set<string>([...orgPermissions(role), ...presetPermissions(preset)]),
    ]),
  );
  const edgeSets: Array<[string, ReadonlySet<string>]> = [
    ["empty", new Set()],
    ["runs:read-all only", new Set(["runs:read-all"])],
    ["agents:run without run read", new Set(["agents:run"])],
    ["agents:write without agents:run", new Set(["agents:write", "runs:read"])],
    ["compose without run read", new Set(["agents:write", "agents:run"])],
    ["authoring over MCP, no run", new Set(["mcp:read", "mcp:invoke", "agents:write"])],
    ["authoring without mcp:invoke", new Set(["mcp:read", "agents:write", "agents:run"])],
    [
      "compose over MCP on read-all",
      new Set(["mcp:read", "mcp:invoke", "agents:write", "agents:run", "runs:read-all"]),
    ],
  ];
  const sets = [...roleSets, ...edgeSets];

  const granted = (operationId: string, set: ReadonlySet<string>) =>
    isGranted(op(operationId).requirement, set);
  const invokes = (set: ReadonlySet<string>) => set.has("mcp:read") && set.has("mcp:invoke");

  /** Predicate ↔ guard pairs; `guards` is the conjunction the predicate claims. */
  const pairs: Array<{
    name: string;
    predicate: (set: ReadonlySet<string>) => boolean;
    guards: (set: ReadonlySet<string>) => boolean;
  }> = [
    {
      name: "canReadRuns ↔ getRun",
      predicate: (set) => canReadRuns((p) => set.has(p)),
      guards: (set) => granted("getRun", set),
    },
    {
      // A launch nobody can poll is not a run the caller can use.
      name: "canRunAgents ↔ runAgent ∧ getRun",
      predicate: (set) => canRunAgents((p) => set.has(p)),
      guards: (set) => granted("runAgent", set) && granted("getRun", set),
    },
    {
      // `runInline` carries no run-read guard: the chat's "compose" level gets
      // that half from `canRunAgents`, pinned above and below.
      name: "canComposeInline ↔ runInline",
      predicate: (set) => canComposeInline((p) => set.has(p)),
      guards: (set) => granted("runInline", set),
    },
    {
      name: "turnCapabilities.authors ↔ invokes ∧ createAgent",
      predicate: (set) => turnCapabilities((p) => set.has(p)).authors,
      guards: (set) => invokes(set) && granted("createAgent", set),
    },
    {
      name: "turnCapabilities reaches read ↔ invokes ∧ getRun",
      predicate: (set) => reaches(turnCapabilities((p) => set.has(p)).runLevel, "read"),
      guards: (set) => invokes(set) && granted("getRun", set),
    },
    {
      name: "turnCapabilities reaches run ↔ invokes ∧ runAgent ∧ getRun",
      predicate: (set) => reaches(turnCapabilities((p) => set.has(p)).runLevel, "run"),
      guards: (set) => invokes(set) && granted("runAgent", set) && granted("getRun", set),
    },
    {
      name: "turnCapabilities reaches compose ↔ invokes ∧ runAgent ∧ getRun ∧ runInline",
      predicate: (set) => reaches(turnCapabilities((p) => set.has(p)).runLevel, "compose"),
      guards: (set) =>
        invokes(set) &&
        granted("runAgent", set) &&
        granted("getRun", set) &&
        granted("runInline", set),
    },
  ];

  for (const { name, predicate, guards } of pairs) {
    it(name, () => {
      const disagreements = sets
        .filter(([, set]) => predicate(set) !== guards(set))
        .map(([label]) => label);
      expect(disagreements).toEqual([]);

      // The control: the pair was judged on both answers, not on a constant.
      const verdicts = new Set(sets.map(([, set]) => predicate(set)));
      expect(verdicts).toEqual(new Set([true, false]));
    });
  }

  it("keeps the raw grants the web chip hardcodes equal to the operations' guards", () => {
    // `apps/web/src/modules/chat/chat-access.ts` cannot be imported here; it
    // holds these strings for its `browseFiles`, `connectIntegrations` and
    // `schedule` rows. A guard change fails here — update that file with it.
    const chip = [
      { operationId: "listFiles", grant: "files:read" },
      { operationId: "initiateIntegrationConnect", grant: "integrations:connect" },
      { operationId: "createSchedule", grant: "schedules:write" },
    ];
    for (const { operationId, grant } of chip) {
      const requirement = op(operationId).requirement;
      expect({ operationId, requirements: requirement.requirements }).toEqual({
        operationId,
        requirements: [grant],
      });
      expect(requirement.targetSpaceRequirements).toEqual([]);
    }
  });
});
