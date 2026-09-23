// SPDX-License-Identifier: Apache-2.0

/**
 * The catalog's join from each operation onto the guards of its route, and the
 * hand-written predicates (core, chat capabilities, web chip) pinned to the
 * operations they stand for. Reads the catalog only — no DB.
 */

import { describe, it, expect } from "bun:test";
import { Hono, type Context, type Next } from "hono";
import { getTestApp } from "../../../helpers/app.ts";
import { registerTestPlatformApp } from "../../../helpers/platform-app.ts";
import { registerPlatformApp } from "../../../../src/lib/platform-app.ts";
import {
  deriveRouteRequirements,
  isGranted,
  servesOperation,
} from "../../../../src/lib/route-requirements.ts";
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
import { PACKAGE_TYPE_ROUTE_SEGMENT } from "@appstrate/core/package-files";
import { reaches, turnCapabilities } from "@appstrate/module-chat/capabilities";
import { getCatalog, type CatalogOperation } from "../../../../src/modules/mcp/catalog.ts";
import type { AppEnv } from "../../../../src/types/index.ts";

await registerTestPlatformApp();

function key(op: CatalogOperation): string {
  return `${op.method} ${op.pathTemplate}`;
}

function op(operationId: string): CatalogOperation {
  const found = getCatalog().operations.get(operationId);
  if (!found) throw new Error(`operation \`${operationId}\` is absent from the catalog`);
  return found;
}

describe("getCatalog — the route join", () => {
  it("resolves a requirement for every operation, with no exception", () => {
    // Registration already threw on any unjoined operation; this is the
    // control that it joined a real surface, not an empty one.
    expect(getCatalog().operations.size).toBeGreaterThan(100);
  });

  it("refuses to register an app when a documented operation has no mounted route", () => {
    // Otherwise an unserved operation would be published as needing nothing.
    const bare = new Hono<AppEnv>();
    bare.get("/api/health", (c) => c.json({ ok: true }));
    expect(() => registerPlatformApp(bare)).toThrow(/no mounted route serves/);
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
    const requirementFor = deriveRouteRequirements(getTestApp().routes);
    expect(requirementFor("POST", "/api/nothing-mounts-this/{id}")).toBeUndefined();
  });
});

type RouteEntry = { method: string; path: string; handler: unknown };

/** Entries read as serving that a later entry of the same registration follows. */
function terminalsBeforeTheEnd(routes: readonly RouteEntry[]): string[] {
  return routes.flatMap((route, i) => {
    const next = routes[i + 1];
    const sameRegistration = next?.method === route.method && next.path === route.path;
    return sameRegistration && servesOperation(route.handler)
      ? [`${route.method} ${route.path}`]
      : [];
  });
}

describe("the arity convention the lookup relies on", () => {
  // `servesOperation` trusts Hono's convention that middleware declares `next`;
  // a middleware written `(...args)` would read as serving and end the lookup.
  // In one registration only the last handler may be terminal.
  it("holds on every registration of the real route table", () => {
    const routes = getTestApp().routes;
    expect(terminalsBeforeTheEnd(routes)).toEqual([]);
    // The control: registrations with middleware in front exist to judge.
    const chained = routes.filter(
      (route, i) => routes[i + 1]?.method === route.method && routes[i + 1]?.path === route.path,
    );
    expect(chained.length).toBeGreaterThan(200);
  });

  it("catches a rest-args middleware in front of a handler", () => {
    const app = new Hono<AppEnv>();
    app.get(
      "/x",
      async (...args: [Context<AppEnv>, Next]) => {
        await args[1]();
      },
      (c) => c.text("ok"),
    );
    expect(terminalsBeforeTheEnd(app.routes)).toEqual(["GET /x"]);
  });

  // A standalone `use` has no handler after it for the check above to see: a
  // rest-args one reads as a terminal catch-all and hides every guard beneath.
  it("serves from no catch-all but the ones pinned here", () => {
    expect(terminalCatchAlls(getTestApp().routes)).toEqual(
      TERMINAL_CATCH_ALLS.map(({ route }) => route).sort(),
    );
  });

  it("flags a standalone rest-args `use` as a catch-all, and not a `(c, next)` one", () => {
    const app = new Hono<AppEnv>();
    app.use("/x/*", async (...args: [Context<AppEnv>, Next]) => {
      await args[1]();
    });
    app.use("/y/*", async (_c, next) => next());
    expect(terminalCatchAlls(app.routes)).toEqual(["ALL /x/*"]);
  });
});

/** Terminal entries answering every method or a whole subtree. */
function terminalCatchAlls(routes: readonly RouteEntry[]): string[] {
  const found = routes
    .filter(
      (route) =>
        servesOperation(route.handler) && (route.method === "ALL" || route.path.endsWith("*")),
    )
    .map((route) => `${route.method} ${route.path}`);
  return [...new Set(found)].sort();
}

const TERMINAL_CATCH_ALLS: ReadonlyArray<{ route: string; why: string }> = [
  { route: "GET /api/auth/*", why: "Better Auth's handler answers its whole family" },
  { route: "POST /api/auth/*", why: "Better Auth's handler answers its whole family" },
  { route: "ALL /api/mcp/o/:org", why: "405 `Allow: POST` for every verb the POST route leaves" },
  { route: "ALL /api/credential-proxy/proxy", why: "forwards the caller's method upstream" },
];

/** Without `methods`, every method at the path. */
type AllowlistEntry = { methods?: readonly string[]; path: string; why: string };

/**
 * `/api/` operations with no permission guard — an unguarded route, GET
 * included, is advertised to every caller — each with the authority that
 * stands in for a guard. A trailing `/*` matches beneath
 * the path, anything else is exact — a bare `x*` matches nothing and reads as
 * stale, since it would also admit `x-anything`. An entry that stops matching fails the suite.
 */
const NO_MOUNTED_GUARD: ReadonlyArray<AllowlistEntry> = [
  // ── The request's own credential is the authority — no RBAC grant to check.
  {
    path: "/api/auth/*",
    why: "each call authenticates by what it carries (password, grant, bootstrap or refresh token); cookie-session calls (get-session, CLI sessions) act on the caller's own sessions only",
  },
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
  { path: "/api/runs/{runId}/events", why: "runner ingestion — HMAC `verifyRunSignature`" },
  { path: "/api/runs/{runId}/events/*", why: "runner ingestion — HMAC `verifyRunSignature`" },
  // NOT `/api/runs/{runId}*`: `sink/extend` carries `agents:run`.
  {
    path: "/api/runs/{runId}/files",
    why: "runner I/O — HMAC `verifyRunSignature` / `verifyRunUploadSignature`",
  },
  {
    path: "/api/runs/{runId}/files/*",
    why: "runner I/O — HMAC `verifyRunSignature` / `verifyRunUploadSignature`",
  },
  { path: "/api/runs/{runId}/workspace", why: "runner input — HMAC `verifyRunSignature`" },
  { path: "/api/oauth/logout", why: "ends the session its own cookie names" },
  { path: "/api/uploads/_content", why: "HMAC upload sink — skips the auth pipeline outright" },
  // Only with `@appstrate/module-ee` loaded (Postgres tiers): see PRESENT_ONLY_WITH_EE.
  { path: "/api/billing/webhooks", why: "Stripe receiver, verified by `stripe-signature`" },

  // ── Self-scoped: the caller's own rows, with no RBAC resource to name.
  { path: "/api/me/*", why: "filtered by the caller's own identity, never by a grant" },
  // Two exact entries: `/api/profiles/batch` carries `members:read`.
  { path: "/api/profile", why: "the person's own account (`isUserPrincipal`)" },
  { path: "/api/profile/password", why: "the person's own account (`isUserPrincipal`)" },
  { path: "/api/notifications", why: "filtered by the caller's actor; another's is a 404" },
  { path: "/api/notifications/*", why: "filtered by the caller's actor; another's is a 404" },
  { path: "/api/uploads", why: "mints an upload token into the caller's own space, nothing else" },
  { path: "/api/welcome/setup", why: "onboarding, on the person's own credential only" },
  // Exact: every other route under `/api/orgs/…` IS guarded.
  { path: "/api/orgs", why: "the caller's own orgs, listed or created outside any org context" },
  { path: "/api/orgs/{orgId}", why: "membership (`orgRole`) is the gate, and every role reads" },
  { path: "/api/orgs/{orgId}/settings", why: "membership (`orgRole`) is the gate, every role" },
  {
    path: "/api/orgs/{orgId}/leave",
    why: "the person's own membership, dashboard session only (`orgRole`); last owner decided under lock",
  },

  // ── No org data at all.
  {
    path: "/api/models/openrouter",
    why: "proxies OpenRouter's public model catalog, rate-limited; nothing of the org's",
  },

  // ── The row the handler loads decides, and refuses with the route's own error.
  // Method-precise: the other methods at these paths carry a mounted guard.
  {
    methods: ["GET"],
    path: "/api/library",
    why: "the caller's own org role (owner/admin), read in the handler",
  },
  {
    methods: ["POST"],
    path: "/api/spaces/{spaceId}/packages",
    why: "`gateSpacePackageWrite`: the per-type permission in the path's space, then the package's rows",
  },
  {
    methods: ["PUT", "DELETE"],
    path: "/api/spaces/{spaceId}/packages/{scope}/{name}",
    why: "`gateSpacePackageWrite`: the per-type permission in the path's space, then the package's rows",
  },
  {
    methods: ["GET"],
    path: "/api/realtime/runs",
    why: "SSE: `validateSSEAuth`, then the run-read disjunction",
  },
  {
    methods: ["GET"],
    path: "/api/realtime/runs/{id}",
    why: "SSE: `validateSSEAuth`, then the run's own visibility",
  },
  {
    methods: ["GET"],
    path: "/api/realtime/agents/{packageId}/runs",
    why: "SSE: `validateSSEAuth`, then the run-read disjunction",
  },
  {
    methods: ["DELETE"],
    path: "/api/files/{id}",
    why: "`files:delete` OR the file's own creator",
  },
  {
    methods: ["POST"],
    path: "/api/files/{id}/keep",
    why: "`files:delete` OR the file's own creator",
  },
  {
    methods: ["GET", "PUT", "DELETE"],
    path: "/api/webhooks/{id}",
    why: "`loadWebhookForAction`, judged in the webhook's space",
  },
  {
    methods: ["POST"],
    path: "/api/webhooks/{id}/test",
    why: "`loadWebhookForAction`, judged in the webhook's space",
  },
  {
    methods: ["POST"],
    path: "/api/webhooks/{id}/rotate",
    why: "`loadWebhookForAction`, judged in the webhook's space",
  },
  {
    methods: ["GET"],
    path: "/api/webhooks/{id}/deliveries",
    why: "`loadWebhookForAction`, judged in the webhook's space",
  },
  {
    methods: ["GET", "PUT"],
    path: "/api/packages/{scope}/{name}/home",
    why: "the package's home space",
  },
  {
    methods: ["GET", "POST"],
    path: "/api/packages/{scope}/{name}/shares",
    why: "`assertPackageShareAccess`: `<type>:share` in the package's home",
  },
  {
    methods: ["DELETE"],
    path: "/api/packages/{scope}/{name}/shares/{target}",
    why: "`assertPackageShareAccess`: `<type>:share` in the package's home",
  },
  {
    methods: ["GET"],
    path: "/api/packages/{scope}/{name}/files",
    why: "`loadFileExplorerPackage`: placement and `<type>:read`; a draft asks its home",
  },
  {
    methods: ["GET"],
    path: "/api/packages/{scope}/{name}/files/content",
    why: "`loadFileExplorerPackage`: placement and `<type>:read`; a draft asks its home",
  },
  {
    methods: ["GET"],
    path: "/api/packages/{scope}/{name}/{version}/download",
    why: "placement, `<type>:read` and the org's copy restriction; a draft asks its home",
  },
  {
    methods: ["PUT"],
    path: "/api/agents/{scope}/{name}/skills",
    why: "`requirePackageInOrg()`: `agents:write` in the agent's home space",
  },
  ...Object.values(PACKAGE_TYPE_ROUTE_SEGMENT).flatMap((segment) =>
    (
      [
        [["PUT", "DELETE"], ""],
        [["POST"], "/versions"],
        [["DELETE"], "/versions/{version}"],
        [["POST"], "/versions/{version}/restore"],
      ] as const
    ).map(([methods, suffix]) => ({
      methods,
      path: `/api/packages/${segment}/{scope}/{name}${suffix}`,
      why: "`requirePackageInOrg()`: the type's write/delete permission in the package's home",
    })),
  ),

  // ── Platform-operator authority, outside org RBAC entirely.
  {
    path: "/api/admin/storage-deletion-jobs",
    why: "platform-operator surface (`requirePlatformAdmin`), not a row and not a grant",
  },
  {
    path: "/api/admin/storage-deletion-jobs/*",
    why: "platform-operator surface (`requirePlatformAdmin`), not a row and not a grant",
  },
];

/** Entries a deployment without `@appstrate/module-ee` cannot match. */
const PRESENT_ONLY_WITH_EE: ReadonlySet<string> = new Set(["/api/billing/webhooks"]);

function covers(
  list: ReadonlyArray<AllowlistEntry>,
  { method, pathTemplate }: { method: string; pathTemplate: string },
): boolean {
  return list.some(
    ({ methods, path }) =>
      (methods === undefined || methods.includes(method)) &&
      (path.endsWith("/*") ? pathTemplate.startsWith(path.slice(0, -1)) : pathTemplate === path),
  );
}

/** `/api/` operations naming no permission in either space. */
function unguardedOperations(): CatalogOperation[] {
  return [...getCatalog().operations.values()].filter(
    (operation) =>
      operation.pathTemplate.startsWith("/api/") &&
      operation.requirement.requirements.length === 0 &&
      operation.requirement.targetSpaceRequirements.length === 0,
  );
}

describe("every /api/ operation has a readable requirement", () => {
  it("names a permission or is allowlisted", () => {
    const offenders = unguardedOperations()
      .filter((operation) => !covers(NO_MOUNTED_GUARD, operation))
      .map((operation) => `${operation.operationId} (${key(operation)})`);
    expect(offenders).toEqual([]);
  });

  it("still has reads and writes to judge", () => {
    // Control for the loop above: a filter excluding everything would pass it.
    // Row-decided GETs are allowlisted by method, so they are not counted as judged.
    const judged = [...getCatalog().operations.values()].filter(
      (operation) =>
        operation.pathTemplate.startsWith("/api/") && !covers(NO_MOUNTED_GUARD, operation),
    );
    expect(judged.filter((operation) => operation.method === "GET").length).toBeGreaterThan(70);
    expect(judged.filter((operation) => operation.method !== "GET").length).toBeGreaterThan(80);
  });

  it("carries no allowlist entry that has stopped standing for anything", () => {
    // An entry matching nothing is a standing excuse for whatever mounts there next.
    // A method entry stands per method: each one must match an unguarded operation.
    const unguarded = unguardedOperations();
    const stale = NO_MOUNTED_GUARD.filter((entry) => !PRESENT_ONLY_WITH_EE.has(entry.path))
      .flatMap((entry) =>
        entry.methods === undefined
          ? [{ entry, label: entry.path }]
          : entry.methods.map((method) => ({
              entry: { ...entry, methods: [method] },
              label: `${method} ${entry.path}`,
            })),
      )
      .filter(({ entry }) => !unguarded.some((operation) => covers([entry], operation)))
      .map(({ label }) => label);
    expect(stale).toEqual([]);
  });

  it("allowlists a method, not the path: a guarded method there is still judged", () => {
    // `PUT`/`DELETE` on a package are row-decided; `GET` on the same path is not.
    expect(op("getAgentPackage").requirement.requirements).toEqual(["agents:read|agents:run"]);
    expect(covers(NO_MOUNTED_GUARD, op("getAgentPackage"))).toBe(false);
    expect(covers(NO_MOUNTED_GUARD, op("updateAgent"))).toBe(true);
  });
});

describe("requirement anchors", () => {
  it("reads a guard-only route as exactly its guard", () => {
    expect(op("createSpace").requirement).toEqual({
      requirements: ["spaces:write"],
      targetSpaceRequirements: [],
    });
  });

  it("reads `listSpaceMembers` as a requirement of the space the PATH names", () => {
    // `requireSpaceFromParam` re-scopes before the guard, so it is asked THERE;
    // as a caller-space requirement it would hide the operation from an org-wide
    // client calling from any other space.
    const requirement = op("listSpaceMembers").requirement;
    expect(requirement.requirements).toEqual([]);
    expect(requirement.targetSpaceRequirements).toContain("space-members:read");

    // The control: without a re-scope in front, a guard stays caller-space.
    expect(op("listApiKeys").requirement).toMatchObject({
      requirements: ["api-keys:read"],
      targetSpaceRequirements: [],
    });
  });

  it("reads the OIDC per-space auth configuration as a requirement of the path's space", () => {
    // The OIDC router enters the `:id` space before `space-settings:write` runs.
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
  function pathSpaceOperations(): CatalogOperation[] {
    return [...getCatalog().operations.values()].filter((operation) =>
      PATH_SPACE.test(operation.pathTemplate),
    );
  }

  it("reports no space-level permission as a caller-space requirement", () => {
    // A hit means the middleware entering the path's space is not `markSpaceRescope`d.
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

/** Each predicate must answer what its operation's guards answer, over every
 *  role a member can hold plus edge sets the presets never produce. */
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
