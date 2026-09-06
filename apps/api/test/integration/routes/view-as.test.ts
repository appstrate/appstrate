// SPDX-License-Identifier: Apache-2.0

/**
 * "View as role" — the server half (docs/architecture/RBAC_PERMISSIONS_SPEC.md §6.7).
 *
 * Every test asserts BOTH halves: what the persona answers, and what the same
 * request without `X-View-As` answers. A preview the server does not enforce
 * looks exactly like a preview it does enforce until you compare the two.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditEvents } from "@appstrate/db/schema";
import {
  setModulePermissionsProvider,
  setPermissionDenialHandler,
  type PermissionDenialContext,
} from "@appstrate/core/permissions";
import type { AppstrateModule } from "@appstrate/core/module";
import { getTestApp, setFeatureFlag } from "../../helpers/app.ts";
import { viewAsWire, type ViewAsPersona as ViewAsSnapshot } from "../../../src/lib/view-as.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  authHeaders,
  createTestContext,
  createTestUser,
  orgOnlyHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedAgent,
  seedApiKey,
  seedInstalledPackage,
  seedRun,
  seedSpace,
  seedSpaceMember,
  seedSpaceRole,
} from "../../helpers/seed.ts";
import { collectSSEEvents, pgNotify } from "../../helpers/sse.ts";
import { initRealtime } from "../../../src/services/realtime.ts";
import { setPlatformApp } from "../../../src/lib/platform-app.ts";
import { resetCatalog } from "../../../src/modules/mcp/catalog.ts";
import { collectModulePermissions } from "../../../src/lib/modules/module-loader.ts";
import { getDiscoveredModules } from "../../helpers/test-modules.ts";
// Reaching into the chat module's source on purpose: this is the one carrier
// whose whole claim is that the persona survives a hop with no header, and the
// minting secret is process-local to that file. Importing it by path gets the
// SAME module instance the discovered chat module registered its strategy from,
// so the token this test mints is one the running app actually verifies.
import { mintMcpLoopbackToken } from "../../../../../packages/module-chat/src/loopback-auth.ts";

const app = getTestApp();
setPlatformApp(app);

/**
 * Resources the probe module in the "intersection with the real caller" block
 * contributes. Declared here because `permissionsContribution()` is typed
 * against `ModuleResources` — a module that grants permissions must open the
 * interface, exactly as `modules/webhooks` and `modules/oidc` do.
 */
declare module "@appstrate/core/permissions" {
  interface ModuleResources {
    "view-as-probe-org": "read";
  }
}

const ACTIVE = "X-View-As-Active";

/** Let PG LISTEN dispatch to SSE subscribers. */
function wait(ms = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ListedSpace {
  id: string;
  role: { kind: string; key: string } | null;
  permissions: string[];
}

interface ListedOrg {
  id: string;
  role: string;
  permissions: string[];
}

interface Problem {
  code: string;
  status: number;
}

describe("view as role", () => {
  let owner: TestContext;

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "view-as" });
  });

  /** `X-View-As` for a persona in the org's default space. */
  function persona(orgRole: "member" | "guest", role?: string, spaceId = owner.defaultSpaceId) {
    return role === undefined
      ? `org_role=${orgRole}`
      : `org_role=${orgRole}; space=${spaceId}; role=${role}`;
  }

  // `view !== undefined`, not a truthiness test: the empty string is a header a
  // client can send and one this suite asserts is refused.
  function listSpaces(view?: string) {
    return app.request("/api/spaces", {
      headers: orgOnlyHeaders(owner, view !== undefined ? { "X-View-As": view } : {}),
    });
  }

  async function listedSpaces(view?: string): Promise<ListedSpace[]> {
    const response = await listSpaces(view);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { data: ListedSpace[] }).data;
  }

  function createAgent(name: string, view?: string) {
    return app.request("/api/packages/agents", {
      method: "POST",
      headers: authHeaders(owner, {
        "Content-Type": "application/json",
        ...(view ? { "X-View-As": view } : {}),
      }),
      body: JSON.stringify({
        manifest: {
          name,
          display_name: "Preview probe",
          description: "Written to prove the persona is enforced on writes",
          schema_version: "0.1",
          version: "0.1.0",
          type: "agent",
        },
        content: "Do the thing",
      }),
    });
  }

  // ─── 1. The persona narrows reads AND writes ──────────────────────

  it("answers as member+viewer for reads and refuses the write the role cannot make", async () => {
    const view = persona("member", "preset:viewer");

    const [previewed] = await listedSpaces(view);
    expect(previewed?.id).toBe(owner.defaultSpaceId);
    expect(previewed?.role).toMatchObject({ kind: "preset", key: "viewer" });
    expect(previewed?.permissions).not.toContain("agents:write");
    expect(previewed?.permissions).toContain("agents:read");

    // Same request, no header: the owner is preset `admin` everywhere.
    const [real] = await listedSpaces();
    expect(real?.role).toMatchObject({ kind: "preset", key: "admin" });
    expect(real?.permissions).toContain("agents:write");

    expect((await createAgent("@view-as/blocked", view)).status).toBe(403);
    expect((await createAgent("@view-as/allowed")).status).toBe(201);
  });

  // ─── 2. A guest with no assignment reaches nothing ────────────────

  it("shows a guest with no space assignment an empty catalog and the role's walls", async () => {
    const privateSpace = await seedSpace({
      orgId: owner.orgId,
      name: "Private",
      visibility: "private",
    });
    const view = persona("guest");

    expect(await listedSpaces(view)).toEqual([]);
    expect((await listedSpaces()).map((space) => space.id).sort()).toEqual(
      [owner.defaultSpaceId, privateSpace.id].sort(),
    );

    const inSpace = (spaceId: string, header?: string) =>
      app.request("/api/agents", {
        headers: authHeaders(owner, {
          "X-Space-Id": spaceId,
          ...(header ? { "X-View-As": header } : {}),
        }),
      });

    // An open space the guest was never added to is a 403; a private one does
    // not exist for them at all.
    const openRefusal = await inSpace(owner.defaultSpaceId, view);
    expect(openRefusal.status).toBe(403);
    expect(((await openRefusal.json()) as Problem).code).toBe("not_a_space_member");
    const hidden = await inSpace(privateSpace.id, view);
    expect(hidden.status).toBe(404);
    // The persona's own wall, answered AS the persona — the generic code and
    // the active marker. This is what `view_as_not_found` has to be told apart
    // from, or a client would end the preview every time it 404s.
    expect(((await hidden.json()) as Problem).code).toBe("not_found");
    expect(hidden.headers.get(ACTIVE)).toBe("1");

    expect((await inSpace(owner.defaultSpaceId)).status).toBe(200);
    expect((await inSpace(privateSpace.id)).status).toBe(200);
  });

  // ─── 3. The persona only ever removes ─────────────────────────────

  it("never grants a permission the real caller lacks, custom bundles included", async () => {
    const restore = setFeatureFlag("custom_roles", true);
    try {
      const role = await seedSpaceRole({
        orgId: owner.orgId,
        key: "auditor",
        permissions: ["space-settings:write", "agents:read"],
      });
      const view = persona("member", `custom:${role.id}`);

      const [previewed] = await listedSpaces(view);
      expect(previewed?.role).toMatchObject({ kind: "custom", key: "auditor" });
      expect(previewed?.permissions).toContain("space-settings:write");
      expect(previewed?.permissions).not.toContain("agents:write");

      const [real] = await listedSpaces();
      const realPermissions = new Set(real?.permissions);
      expect(previewed?.permissions.filter((p) => !realPermissions.has(p))).toEqual([]);
      expect(previewed!.permissions.length).toBeLessThan(real!.permissions.length);

      // The org listing is narrowed the same way, and the org role it reports is
      // the persona's — the SPA derives its top-level gates from this row.
      const orgs = async (header?: string) => {
        const response = await app.request("/api/orgs", {
          headers: orgOnlyHeaders(owner, header ? { "X-View-As": header } : {}),
        });
        expect(response.status, await response.clone().text()).toBe(200);
        return ((await response.json()) as { data: ListedOrg[] }).data;
      };
      const [previewedOrg] = await orgs(view);
      const [realOrg] = await orgs();
      expect(previewedOrg?.role).toBe("member");
      expect(realOrg?.role).toBe("owner");
      expect(realOrg?.permissions).toContain("members:remove");
      expect(previewedOrg?.permissions).not.toContain("members:remove");
      const realOrgPermissions = new Set(realOrg?.permissions);
      expect(previewedOrg?.permissions.filter((p) => !realOrgPermissions.has(p))).toEqual([]);
    } finally {
      restore();
    }
  });

  // ─── 4. Refusals, never a fall-back ───────────────────────────────

  describe("refusals", () => {
    const denials: string[] = [];

    beforeEach(() => {
      denials.length = 0;
      setPermissionDenialHandler((ctx: PermissionDenialContext) => {
        denials.push(ctx.required);
      });
    });

    afterEach(() => setPermissionDenialHandler(null));

    it("names the persona on a denial decided UNDER a preview", async () => {
      // `installPermissionAuditLogger` is what production registers; the fields
      // it logs are asserted here through the same seam it uses.
      const records: Array<Record<string, unknown>> = [];
      setPermissionDenialHandler((ctx: PermissionDenialContext) => {
        const c = ctx.c as { get: (key: string) => unknown };
        const p = c.get("viewAs") as ViewAsSnapshot | undefined;
        records.push({
          required: ctx.required,
          role: c.get("orgRole"),
          viewAs: p ? viewAsWire(p) : undefined,
        });
      });
      try {
        // A disjunction refusal, which is the shape that reaches the hook
        // outside `makePermissionGuard`.
        const refused = await app.request(`/api/spaces/${owner.defaultSpaceId}/roles`, {
          headers: orgOnlyHeaders(owner, { "X-View-As": persona("member", "preset:builder") }),
        });
        expect(refused.status).toBe(403);
        expect(records).toHaveLength(1);
        // The REAL role beside the persona: a trail that lost either could not
        // tell an abuse attempt from a preview.
        expect(records[0]).toMatchObject({
          role: "owner",
          viewAs: {
            org_role: "member",
            space: {
              space_id: owner.defaultSpaceId,
              role: { kind: "preset", key: "builder", name: "builder" },
            },
          },
        });
      } finally {
        setPermissionDenialHandler(null);
      }
    });

    it("refuses a caller who is neither owner nor admin, and audits the attempt", async () => {
      const user = await createTestUser();
      await addOrgMember(owner.orgId, user.id, "member");
      const asMember = { ...owner, user, cookie: user.cookie };

      const refused = await app.request("/api/spaces", {
        headers: orgOnlyHeaders(asMember, { "X-View-As": persona("guest") }),
      });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as Problem).code).toBe("view_as_forbidden");
      expect(denials).toEqual(["view_as:guest"]);

      // The same caller without the header still reads its own spaces.
      expect((await app.request("/api/spaces", { headers: orgOnlyHeaders(asMember) })).status).toBe(
        200,
      );
    });

    it("refuses a credential that cannot carry a persona", async () => {
      const key = await seedApiKey({
        orgId: owner.orgId,
        spaceId: owner.defaultSpaceId,
        createdBy: owner.user.id,
        scopes: ["spaces:read"],
      });
      const withKey = (extra: Record<string, string> = {}) =>
        app.request("/api/spaces", {
          headers: { Authorization: `Bearer ${key.rawKey}`, ...extra },
        });

      const refused = await withKey({ "X-View-As": persona("member", "preset:viewer") });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as Problem).code).toBe("view_as_unsupported");
      expect((await withKey()).status).toBe(200);
    });

    it.each([
      ["org_role=owner", "an org role a preview may not take"],
      ["org_role=admin", "the other ineligible org role"],
      ["org_role=member; space=spc_x", "a space with no role"],
      ["role=preset:viewer", "a role with no space and no org role"],
      ["", "an empty value"],
      ["org_role=member; nonsense", "a segment that is not a pair"],
      ["org_role=member; org_role=guest", "a repeated key"],
      ["org_role=member; unknown=1", "an unknown key"],
    ])("refuses %p — %s", async (header) => {
      const response = await listSpaces(header);
      expect(response.status, await response.clone().text()).toBe(400);
      expect(((await response.json()) as Problem).code).toBe("invalid_view_as");
    });

    it("refuses a persona this listing cannot place", async () => {
      const view = persona("member", "preset:viewer");
      // No `X-Org-Id`: the listings are exempt from org context, so nothing
      // names the org the role is previewed in.
      const orphan = await app.request("/api/orgs", {
        headers: { Cookie: owner.cookie, "X-View-As": view },
      });
      expect(orphan.status).toBe(400);
      expect(((await orphan.json()) as Problem).code).toBe("invalid_view_as");

      // An org the caller is not a member of matches no row to narrow.
      const other = await createTestContext({ orgSlug: "view-as-stranger" });
      const stranger = await app.request("/api/orgs", {
        headers: { Cookie: owner.cookie, "X-Org-Id": other.orgId, "X-View-As": view },
      });
      expect(stranger.status).toBe(404);
      expect(((await stranger.json()) as Problem).code).toBe("view_as_not_found");

      // Control: the same header with the caller's own org is answered.
      const placed = await app.request("/api/orgs", {
        headers: orgOnlyHeaders(owner, { "X-View-As": view }),
      });
      expect(placed.status).toBe(200);
      expect(placed.headers.get(ACTIVE)).toBe("1");
    });

    it("refuses a malformed space id at the header, not at some later field", async () => {
      const malformed = await listSpaces("org_role=member; space=app_legacy; role=preset:viewer");
      expect(malformed.status).toBe(400);
      const body = (await malformed.json()) as Problem & { param?: string };
      expect(body.code).toBe("invalid_view_as");
      expect(body.param).toBe("X-View-As");
      // Control: the same request with a well-shaped id gets past parsing.
      expect((await listSpaces(persona("member", "preset:viewer"))).status).toBe(200);
    });

    it("refuses a space that is not in the organization", async () => {
      const other = await createTestContext({ orgSlug: "view-as-other" });
      const response = await listSpaces(persona("member", "preset:viewer", other.defaultSpaceId));
      expect(response.status).toBe(404);
      // Its OWN code, not the generic `not_found`: this is the preview dying,
      // not the previewed role failing to find something. A client cannot tell
      // "drop the persona" from "this row does not exist for you" otherwise.
      expect(((await response.json()) as Problem).code).toBe("view_as_not_found");
      expect((await listSpaces()).status).toBe(200);
    });

    it("refuses a custom role that belongs to another organization", async () => {
      const restore = setFeatureFlag("custom_roles", true);
      try {
        const other = await createTestContext({ orgSlug: "view-as-foreign" });
        const foreign = await seedSpaceRole({ orgId: other.orgId, key: "foreign" });
        const refused = await listSpaces(persona("member", `custom:${foreign.id}`));
        expect(refused.status).toBe(404);
        expect(((await refused.json()) as Problem).code).toBe("view_as_not_found");
        const mine = await seedSpaceRole({ orgId: owner.orgId, key: "mine" });
        expect((await listSpaces(persona("member", `custom:${mine.id}`))).status).toBe(200);
      } finally {
        restore();
      }
    });

    it("refuses a custom role where the custom_roles feature is off", async () => {
      const role = await seedSpaceRole({ orgId: owner.orgId, key: "ungated" });
      const restore = setFeatureFlag("custom_roles", false);
      try {
        const response = await listSpaces(persona("member", `custom:${role.id}`));
        expect(response.status).toBe(403);
        // A view-as refusal, not the role routes' `feature_unavailable`: every
        // way a persona is turned down must be a code the client drops it on.
        expect(((await response.json()) as Problem).code).toBe("view_as_forbidden");
        // A preset preview stays available on the same deployment.
        expect((await listSpaces(persona("member", "preset:viewer"))).status).toBe(200);
      } finally {
        restore();
      }
    });
  });

  // ─── The other two surfaces the SPA gates on ──────────────────────

  it("narrows GET /api/me/orgs for the previewed org and no other", async () => {
    const other = await createTestContext({ orgSlug: "view-as-second" });
    await addOrgMember(other.orgId, owner.user.id, "owner");
    const view = persona("member", "preset:viewer");

    const myOrgs = async (header?: string) => {
      const response = await app.request("/api/me/orgs", {
        headers: orgOnlyHeaders(owner, header !== undefined ? { "X-View-As": header } : {}),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { data: ListedOrg[] }).data;
    };

    const previewed = await myOrgs(view);
    const previewedHere = previewed.find((org) => org.id === owner.orgId);
    const previewedThere = previewed.find((org) => org.id === other.orgId);
    expect(previewedHere?.role).toBe("member");
    expect(previewedHere?.permissions).not.toContain("members:remove");
    // `X-Org-Id` named the first org, so the second is untouched: a preview is
    // validated in one organization and applies only there.
    expect(previewedThere?.role).toBe("owner");
    expect(previewedThere?.permissions).toContain("members:remove");

    const real = await myOrgs();
    expect(real.find((org) => org.id === owner.orgId)?.role).toBe("owner");
  });

  it("offers only the roles the persona could assign", async () => {
    const roles = async (header?: string) => {
      const response = await app.request(`/api/spaces/${owner.defaultSpaceId}/roles`, {
        headers: orgOnlyHeaders(owner, header !== undefined ? { "X-View-As": header } : {}),
      });
      return response;
    };

    // Preset `builder` holds no `space-members:*`, so the roles catalogue is
    // not even readable — the same wall a real builder hits.
    expect((await roles(persona("member", "preset:builder"))).status).toBe(403);

    // Preset `admin` reads it, but a role is only offered if the persona itself
    // holds every permission in it.
    const asSpaceAdmin = await roles(persona("member", "preset:admin"));
    expect(asSpaceAdmin.status, await asSpaceAdmin.clone().text()).toBe(200);
    expect(asSpaceAdmin.headers.get(ACTIVE)).toBe("1");
    const offered = ((await asSpaceAdmin.json()) as { data: Array<{ key: string }> }).data.map(
      (role) => role.key,
    );
    expect(offered).toEqual(expect.arrayContaining(["admin", "builder", "operator", "viewer"]));

    const real = await roles();
    expect(real.status).toBe(200);
    expect(real.headers.get(ACTIVE)).toBeNull();
  });

  // ─── 5. Audit names the persona and keeps the real actor ──────────

  it("records the persona on a write made under preview", async () => {
    const view = persona("member", "preset:admin");
    const patch = (header?: string) =>
      app.request(`/api/spaces/${owner.defaultSpaceId}`, {
        method: "PATCH",
        headers: orgOnlyHeaders(owner, {
          "Content-Type": "application/json",
          ...(header ? { "X-View-As": header } : {}),
        }),
        body: JSON.stringify({ name: header ? "Renamed under preview" : "Renamed for real" }),
      });

    expect((await patch(view)).status).toBe(200);
    expect((await patch()).status).toBe(200);

    const rows = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, owner.orgId), eq(auditEvents.action, "space.updated")));
    const previewed = rows.find((row) =>
      (row.after as { name?: string }).name?.includes("preview"),
    );
    const real = rows.find((row) => (row.after as { name?: string }).name?.includes("real"));

    expect(previewed?.actorId).toBe(owner.user.id);
    expect(previewed?.actorType).toBe("user");
    expect((previewed?.after as { view_as?: unknown }).view_as).toEqual({
      org_role: "member",
      space: {
        space_id: owner.defaultSpaceId,
        role: { kind: "preset", key: "admin", name: "admin" },
      },
    });
    // The control: the same write with no header carries no persona at all.
    expect(real?.after).not.toHaveProperty("view_as");
  });

  // ─── 6. Nothing acts on the REAL org role behind the persona ──────

  describe("persona-sensitive call sites", () => {
    /**
     * Three greps, one rule: every site that answers "what does this caller
     * reach" must go through a persona-aware accessor, and every site that does
     * NOT is pinned here with why. A new call site fails this test on purpose —
     * it has to be reviewed against the preview before it ships.
     *
     * `.get("orgRole")` — the real role, which a preview deliberately leaves
     * untouched ({@link callerOrgRole} is the previewed one).
     * `loadSpaceMember(` / `loadSpaceMemberships(` — the caller's own rows,
     * which a preview replaces with its overlay (`callerSpaceMember*`).
     * `orgPermissions(` — a role's org grants, which a preview intersects
     * (`orgHalfFor`).
     */
    interface Sweep {
      what: string;
      pattern: RegExp;
      control: string;
      allowlist: ReadonlyArray<[string, string]>;
    }

    const SWEEPS: Sweep[] = [
      {
        what: '`.get("orgRole")`',
        // Whitespace- and alias-tolerant: prettier may wrap the call, and
        // `space-context.ts` reaches the context through a `ctx` alias.
        pattern: /\.get\(\s*"orgRole"\s*\)/,
        control: "apps/api/src/lib/auth-pipeline.ts",
        allowlist: [
          [
            "apps/api/src/lib/auth-pipeline.ts",
            "resolves the REAL role the persona's eligibility is judged against",
          ],
          [
            "apps/api/src/lib/package-access.ts",
            "distinguishes an end-user (no org role at all) from a member",
          ],
          [
            "apps/api/src/lib/permission-audit.ts",
            "a denial trail must name the real role, persona or not",
          ],
          ["apps/api/src/lib/view-as.ts", "defines what real and previewed mean"],
          [
            "apps/api/src/middleware/org-path-context.ts",
            "membership existence, which a preview never changes",
          ],
          [
            "apps/api/src/middleware/space-context.ts",
            "membership existence gate before the persona is applied",
          ],
          [
            "apps/api/src/routes/organizations.ts",
            "two membership-existence gates; the who-manages-whom policy reads `callerOrgRole`",
          ],
          [
            "packages/module-chat/src/chat-stream.ts",
            "the fallback under the persona's role, which is what the turn is answered as",
          ],
          [
            "packages/module-chat/src/prompt.ts",
            "the fallback behind the persona's role in the caller-context block",
          ],
        ],
      },
      {
        what: "`loadSpaceMember(` / `loadSpaceMemberships(`",
        pattern: /loadSpaceMember(?:ships)?\(/,
        control: "apps/api/src/lib/view-as.ts",
        allowlist: [
          ["apps/api/src/lib/space-role.ts", "defines them"],
          ["apps/api/src/lib/view-as.ts", "the persona-aware accessors every other site uses"],
          [
            "apps/api/src/routes/realtime.ts",
            'SSE runs outside the pipeline and has no `c.get("user")`; it overlays explicitly',
          ],
          [
            "apps/api/src/routes/spaces.ts",
            "reads the TARGET member's row on a role change, not the caller's",
          ],
          [
            "apps/api/src/services/spaces.ts",
            "the listing's own load, bypassed by the overlay `listSpacesForPrincipal` takes",
          ],
        ],
      },
      {
        what: "`orgPermissions(`",
        pattern: /[^a-zA-Z]orgPermissions\(/,
        control: "apps/api/src/lib/view-as.ts",
        allowlist: [
          ["apps/api/src/lib/permissions.ts", "defines it"],
          [
            "apps/api/src/lib/view-as.ts",
            "`orgHalfFor`, the one site that applies a persona to it",
          ],
          [
            "apps/api/src/modules/oidc/auth/claims.ts",
            "mints a token's scope CEILING from the subject's role; a preview narrows per request, under it",
          ],
        ],
      },
    ];

    /**
     * Comments name these helpers freely, and only real call sites are the
     * subject. Whole comment lines are blanked rather than parsed out: a
     * regex-based comment stripper eats code the moment a string literal holds
     * `/*` (`app.on([...], "/api/auth/*", …)` does), and a line of code never
     * begins with `*`, `//` or `/*`. Newlines survive, so a call prettier
     * wrapped across lines still matches.
     */
    const stripCommentLines = (source: string): string =>
      source
        .split("\n")
        .map((line) => {
          const t = line.trimStart();
          return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : line;
        })
        .join("\n");

    it.each(SWEEPS)("$what is read only where the allowlist says", async (sweep: Sweep) => {
      const root = `${import.meta.dir}/../../../../..`;
      const found: string[] = [];
      for (const area of ["apps/api/src", "packages"]) {
        const glob = area === "packages" ? "*/src/**/*.ts" : "**/*.ts";
        for await (const relative of new Bun.Glob(glob).scan({ cwd: `${root}/${area}` })) {
          // Tests are not production call sites — the oidc module keeps its own
          // under `src/`, so they have to be excluded by path.
          if (relative.includes("/test/") || relative.endsWith(".test.ts")) continue;
          const path = `${area}/${relative}`;
          const source = stripCommentLines(await Bun.file(`${root}/${path}`).text());
          if (sweep.pattern.test(source)) found.push(path);
        }
      }
      // Positive control: a pattern that matched nothing would pass an empty
      // allowlist just as happily.
      expect(found).toContain(sweep.control);
      expect(found.sort()).toEqual(sweep.allowlist.map(([file]) => file).sort());
    });

    it("refuses the org-member policies a previewed member cannot reach", async () => {
      const target = await createTestUser();
      await addOrgMember(owner.orgId, target.id, "member");
      const view = persona("member", "preset:admin");
      const headers = (header?: string) =>
        orgOnlyHeaders(owner, {
          "Content-Type": "application/json",
          ...(header ? { "X-View-As": header } : {}),
        });
      const memberPath = `/api/orgs/${owner.orgId}/members/${target.id}`;

      const changeRole = (header?: string) =>
        app.request(memberPath, {
          method: "PUT",
          headers: headers(header),
          body: JSON.stringify({ role: "admin" }),
        });
      expect((await changeRole(view)).status).toBe(403);
      expect((await changeRole()).status).toBe(200);

      const remove = (header?: string) =>
        app.request(memberPath, { method: "DELETE", headers: headers(header) });
      expect((await remove(view)).status).toBe(403);
      expect((await remove()).status).toBe(204);
    });

    it("refuses the space catalog writes a previewed member cannot reach", async () => {
      const view = persona("member", "preset:admin");
      const headers = (header?: string) =>
        orgOnlyHeaders(owner, {
          "Content-Type": "application/json",
          ...(header ? { "X-View-As": header } : {}),
        });

      const create = (header?: string) =>
        app.request("/api/spaces", {
          method: "POST",
          headers: headers(header),
          body: JSON.stringify({ name: header ? "Under preview" : "For real" }),
        });
      // `spaces:write` is org-level and admin-tier: preset `admin` in a space
      // does not buy it, which is the whole point of the two-layer model.
      expect((await create(view)).status).toBe(403);
      const created = await create();
      expect(created.status).toBe(201);
      const createdId = ((await created.json()) as { id: string }).id;

      const remove = (header?: string) =>
        app.request(`/api/spaces/${createdId}`, { method: "DELETE", headers: headers(header) });
      expect((await remove(view)).status).toBe(403);
      expect((await remove()).status).toBe(204);
    });

    it("answers the package catalog as a member would, not as the org catalog admin", async () => {
      // Installed in no space: only someone who manages the ORG catalog sees it.
      await seedAgent({ id: "@view-as/uninstalled", orgId: owner.orgId });
      const library = async (header?: string) => {
        const response = await app.request("/api/library", {
          headers: orgOnlyHeaders(owner, header ? { "X-View-As": header } : {}),
        });
        expect(response.status, await response.clone().text()).toBe(200);
        const body = (await response.json()) as { packages: { agent: Array<{ id: string }> } };
        return body.packages.agent.map((pkg) => pkg.id);
      };

      expect(await library()).toContain("@view-as/uninstalled");
      expect(await library(persona("member", "preset:admin"))).not.toContain(
        "@view-as/uninstalled",
      );
    });
  });

  // ─── S2. The "∩ real" narrowing is what stops a non-nested role set ─

  describe("intersection with the real caller", () => {
    /**
     * A module whose ORG grants are not nested inside the previewing owner's.
     *
     * With the core vocabulary alone every persona set is a subset of every
     * eligible caller's set, so the intersection is provably the identity and a
     * test written against core permissions cannot tell it from a no-op. Org
     * roles are where it can differ: nothing requires a module's `grantTo` to
     * be upward-closed (unlike `presets`, which the loader DOES hold nested —
     * `assertPresetsUpwardClosed`), so a module may grant an org-level
     * permission to `member` and not to `owner`, and then the intersection is
     * the only thing keeping the preview from handing the owner a permission
     * they do not have.
     */
    const probeModule: AppstrateModule = {
      manifest: { id: "view-as-probe", name: "View-As Probe", version: "1.0.0" },
      async init() {},
      permissionsContribution: () => [
        { resource: "view-as-probe-org", actions: ["read"], level: "org", grantTo: ["member"] },
      ],
    };
    const ORG_PROBE = "view-as-probe-org:read";

    // The provider is process-global (`getTestApp` re-registers it on every
    // call, at module load), so it is swapped for this block only and put back
    // exactly as the harness had it.
    beforeAll(() => {
      const snapshot = collectModulePermissions([...getDiscoveredModules(), probeModule]);
      setModulePermissionsProvider(() => snapshot);
    });
    afterAll(() => {
      const snapshot = collectModulePermissions(getDiscoveredModules());
      setModulePermissionsProvider(() => snapshot);
    });

    it("drops what the previewed role grants and the previewer does not hold", async () => {
      const listedFor = async (ctx: TestContext, header?: string) => {
        const response = await app.request("/api/orgs", {
          headers: orgOnlyHeaders(ctx, header !== undefined ? { "X-View-As": header } : {}),
        });
        expect(response.status, await response.clone().text()).toBe(200);
        const body = (await response.json()) as { data: ListedOrg[] };
        return body.data.find((org) => org.id === ctx.orgId)?.permissions ?? [];
      };

      // A REAL member of the org holds the probe — this is what the persona is
      // claiming to show.
      const user = await createTestUser();
      await addOrgMember(owner.orgId, user.id, "member");
      expect(await listedFor({ ...owner, user, cookie: user.cookie })).toContain(ORG_PROBE);

      // The previewing owner does NOT: the module granted it to `member` only.
      expect(await listedFor(owner)).not.toContain(ORG_PROBE);

      // So the preview must not show it either — the persona's grants
      // intersected with the previewer's. Drop the intersection and this is the
      // assertion that fails: the owner would gain a permission by previewing.
      const previewed = await listedFor(owner, persona("member"));
      expect(previewed).not.toContain(ORG_PROBE);
      // …and the preview is genuinely in force, so the absence above is the
      // intersection's doing and not a persona that never applied.
      expect(previewed).toContain("roles:read");
      expect(previewed).not.toContain("members:remove");
    });
  });

  // ─── S3. A persona applies to its own organization and no other ───

  it("leaves the caller their real standing in a second organization", async () => {
    // Source org, where the previewing owner is a plain member with an explicit
    // `builder` row in a PRIVATE space — reachable only through that row.
    const source = await createTestContext({ orgSlug: "view-as-source" });
    await addOrgMember(source.orgId, owner.user.id, "member");
    const vault = await seedSpace({
      orgId: source.orgId,
      name: "Vault",
      visibility: "private",
    });
    await seedSpaceMember({ spaceId: vault.id, userId: owner.user.id, presetRole: "builder" });

    const created = await app.request("/api/packages/agents", {
      method: "POST",
      headers: authHeaders(source, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        manifest: {
          name: "@view-as-source/shared",
          display_name: "Shared",
          description: "Lives in another organization",
          schema_version: "0.1",
          version: "0.1.0",
          type: "agent",
        },
        content: "Do the thing",
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    await seedInstalledPackage(vault.id, "@view-as-source/shared");

    // Persona `builder` in the previewing owner's OWN org, so the write half of
    // the fork is satisfied there and the only question left is the source org.
    const fork = (header?: string) =>
      app.request("/api/packages/@view-as-source/shared/fork", {
        method: "POST",
        headers: authHeaders(owner, {
          "Content-Type": "application/json",
          ...(header ? { "X-View-As": header } : {}),
        }),
        body: JSON.stringify({ name: header ? "under-preview" : "for-real" }),
      });

    // The persona narrows org A. In org B the caller is nobody's persona — they
    // are a real member with a real row, and the fork sees the package.
    const previewed = await fork(persona("member", "preset:builder"));
    expect(previewed.status, await previewed.clone().text()).toBe(201);
    expect(previewed.headers.get(ACTIVE)).toBe("1");

    const real = await fork();
    expect(real.status, await real.clone().text()).toBe(201);
  });

  // ─── B1. Server-Sent Events carry the persona too ─────────────────

  describe("realtime SSE", () => {
    beforeAll(async () => {
      await initRealtime();
    });

    function stream(query: string, ctx: TestContext = owner) {
      return app.request(
        `/api/realtime/runs?orgId=${ctx.orgId}&spaceId=${ctx.defaultSpaceId}${query}`,
        { headers: { Cookie: ctx.cookie, Accept: "text/event-stream" } },
      );
    }

    it("stops a previewed guest at the same wall the HTTP pipeline does", async () => {
      const privateSpace = await seedSpace({
        orgId: owner.orgId,
        name: "Private",
        visibility: "private",
      });
      const guest = encodeURIComponent(persona("guest"));

      const open = await stream(`&${"view_as"}=${guest}`);
      expect(open.status).toBe(403);
      expect(((await open.json()) as Problem).code).toBe("not_a_space_member");
      expect(open.headers.get(ACTIVE)).toBe("1");

      const hidden = await app.request(
        `/api/realtime/runs?orgId=${owner.orgId}&spaceId=${privateSpace.id}&view_as=${guest}`,
        { headers: { Cookie: owner.cookie, Accept: "text/event-stream" } },
      );
      expect(hidden.status).toBe(404);

      // Control: the same two streams without the persona are the owner's.
      const asOwner = await stream("");
      expect(asOwner.status).toBe(200);
      expect(asOwner.headers.get(ACTIVE)).toBeNull();
      await asOwner.body?.cancel();
      const asOwnerPrivate = await app.request(
        `/api/realtime/runs?orgId=${owner.orgId}&spaceId=${privateSpace.id}`,
        { headers: { Cookie: owner.cookie, Accept: "text/event-stream" } },
      );
      expect(asOwnerPrivate.status).toBe(200);
      await asOwnerPrivate.body?.cancel();
    });

    it("opens for a previewed viewer but withholds the debug frames the role cannot see", async () => {
      const agentPkg = await seedAgent({ orgId: owner.orgId });
      const run = await seedRun({
        packageId: agentPkg.id,
        orgId: owner.orgId,
        spaceId: owner.defaultSpaceId,
      });
      const viewer = encodeURIComponent(persona("member", "preset:viewer"));

      const response = await stream(`&view_as=${viewer}`);
      expect(response.status).toBe(200);
      expect(response.headers.get(ACTIVE)).toBe("1");

      // `runs:delete` is what gates debug-level frames, and a viewer has none.
      await wait();
      await pgNotify("run_log_insert", {
        org_id: owner.orgId,
        space_id: owner.defaultSpaceId,
        run_id: run.id,
        level: "debug",
        message: "debug-secret",
      });
      await wait();
      await pgNotify("run_log_insert", {
        org_id: owner.orgId,
        space_id: owner.defaultSpaceId,
        run_id: run.id,
        level: "info",
        message: "info-visible",
      });
      const events = await collectSSEEvents(response.body!, 1, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.data).message).toBe("info-visible");
    });

    it("refuses the persona as a header, pointing at the query parameter", async () => {
      const refused = await app.request(
        `/api/realtime/runs?orgId=${owner.orgId}&spaceId=${owner.defaultSpaceId}`,
        {
          headers: {
            Cookie: owner.cookie,
            Accept: "text/event-stream",
            "X-View-As": persona("member", "preset:viewer"),
          },
        },
      );
      expect(refused.status).toBe(400);
      const body = (await refused.json()) as Problem & { detail: string };
      expect(body.code).toBe("invalid_view_as");
      expect(body.detail).toContain("view_as");
      // Control: the same persona as the query parameter opens the stream.
      const opened = await stream(
        `&view_as=${encodeURIComponent(persona("member", "preset:viewer"))}`,
      );
      expect(opened.status).toBe(200);
      await opened.body?.cancel();
    });

    it("audits an ineligible caller's attempt with the actor that made it", async () => {
      const seen: Array<{ required: string; actorId?: string; orgId?: string; role?: string }> = [];
      setPermissionDenialHandler((ctx: PermissionDenialContext) => {
        const c = ctx.c as {
          get: (key: string) => unknown;
        };
        seen.push({
          required: ctx.required,
          actorId: (c.get("user") as { id: string } | undefined)?.id,
          orgId: c.get("orgId") as string | undefined,
          role: c.get("orgRole") as string | undefined,
        });
      });
      try {
        const user = await createTestUser();
        await addOrgMember(owner.orgId, user.id, "member");
        const refused = await app.request(
          `/api/realtime/runs?orgId=${owner.orgId}&spaceId=${owner.defaultSpaceId}&view_as=${encodeURIComponent(persona("guest"))}`,
          { headers: { Cookie: user.cookie, Accept: "text/event-stream" } },
        );
        expect(refused.status).toBe(403);
        expect(((await refused.json()) as Problem).code).toBe("view_as_forbidden");
        // A denial record naming no actor is not a record: these routes run
        // outside the pipeline, so nothing else would have put them on the
        // context.
        expect(seen).toEqual([
          {
            required: "view_as:guest",
            actorId: user.id,
            orgId: owner.orgId,
            role: "member",
          },
        ]);
      } finally {
        setPermissionDenialHandler(null);
      }
    });

    it("refuses a malformed persona on the query parameter", async () => {
      const refused = await stream("&view_as=org_role=owner");
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as Problem).code).toBe("invalid_view_as");
      const opened = await stream("");
      expect(opened.status).toBe(200);
      await opened.body?.cancel();
    });

    it("refuses a persona on a credential that cannot carry one", async () => {
      const key = await seedApiKey({
        orgId: owner.orgId,
        spaceId: owner.defaultSpaceId,
        createdBy: owner.user.id,
        scopes: ["runs:read"],
      });
      const refused = await app.request(
        `/api/realtime/runs?token=${key.rawKey}&view_as=${encodeURIComponent(persona("guest"))}`,
      );
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as Problem).code).toBe("view_as_unsupported");

      const allowed = await app.request(`/api/realtime/runs?token=${key.rawKey}`);
      expect(allowed.status).toBe(200);
      await allowed.body?.cancel();
    });
  });

  // ─── B2. The chat module's in-process loopback carries it ─────────

  describe("chat in-process loopback", () => {
    /** What `chat-stream.ts` forwards: the caller's already-resolved set. */
    const SCOPE = ["spaces:read", "agents:read", "skills:read"] as const;

    async function libraryOverLoopback(orgRole: string, viewAs?: unknown): Promise<string[]> {
      const token = mintMcpLoopbackToken({
        userId: owner.user.id,
        email: owner.user.email,
        name: owner.user.name,
        orgId: owner.orgId,
        orgRole,
        permissions: [...SCOPE],
        viewAs,
      });
      const response = await app.request("/api/library", {
        headers: { Authorization: `Bearer ${token}`, "X-Org-Id": owner.orgId },
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as { packages: { agent: Array<{ id: string }> } };
      return body.packages.agent.map((pkg) => pkg.id);
    }

    it("reaches a closed space the persona is a member of, and only with the claim", async () => {
      // A CLOSED space reaches nobody without a row, so what the hop sees there
      // depends on the persona's overlay and on nothing else.
      const closed = await seedSpace({
        orgId: owner.orgId,
        name: "Closed",
        visibility: "closed",
      });
      await seedAgent({ id: "@view-as/in-closed", orgId: owner.orgId });
      await seedInstalledPackage(closed.id, "@view-as/in-closed");

      const persona = {
        orgId: owner.orgId,
        orgRole: "member",
        space: { spaceId: closed.id, role: { kind: "preset", preset: "builder" } },
      };
      // The claim carries the overlay, so the hop is a builder in that space.
      expect(await libraryOverLoopback("member", persona)).toContain("@view-as/in-closed");
      // Strip it and the same token — same identity, same scope, same org role —
      // reaches nothing there: a `member` with no row is not in a closed space.
      expect(await libraryOverLoopback("member")).not.toContain("@view-as/in-closed");
    });

    it("ignores a claim minted for another organization", async () => {
      await seedAgent({ id: "@view-as/other-org-claim", orgId: owner.orgId });
      const foreign = await createTestContext({ orgSlug: "view-as-elsewhere" });
      // A persona applies in ONE org. Adopting this one would narrow nothing
      // (every accessor is org-keyed) and stamp a marker no persona earned.
      const response = await app.request("/api/library", {
        headers: {
          Authorization: `Bearer ${mintMcpLoopbackToken({
            userId: owner.user.id,
            email: owner.user.email,
            name: owner.user.name,
            orgId: owner.orgId,
            orgRole: "owner",
            permissions: [...SCOPE],
            viewAs: { orgId: foreign.orgId, orgRole: "member", space: null },
          })}`,
          "X-Org-Id": owner.orgId,
        },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get(ACTIVE)).toBeNull();
    });

    it("hides the org catalogue a `member` does not manage", async () => {
      // Installed in no space: only someone who manages the ORG catalog sees it.
      await seedAgent({ id: "@view-as/uninstalled", orgId: owner.orgId });
      expect(await libraryOverLoopback("owner")).toContain("@view-as/uninstalled");
      expect(await libraryOverLoopback("member")).not.toContain("@view-as/uninstalled");
    });
  });

  // ─── B1b. The inbound MCP endpoint re-enters with the persona ─────

  it("carries the persona into the MCP endpoint's in-process dispatch", async () => {
    resetCatalog();
    // `mcp:invoke` is space-level and reaches preset `operator`; `spaces:write`
    // is org-level and admin-tier. So this persona can drive the tool and must
    // still be refused the operation it drives — which only holds if the header
    // survives the hop into `POST /api/spaces`.
    const view = persona("member", "preset:operator");
    const invoke = async (header?: string) => {
      const response = await app.request(`/api/mcp/o/${owner.orgId}`, {
        method: "POST",
        headers: {
          ...authHeaders(owner, header ? { "X-View-As": header } : {}),
          "content-type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "invoke_operation",
            arguments: {
              operation_id: "createSpace",
              body: { name: header ? "Via preview" : "Via owner" },
            },
          },
        }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const envelope = (await response.json()) as {
        result?: { isError?: boolean; content?: Array<{ text: string }> };
      };
      const text = envelope.result?.content?.[0]?.text ?? "{}";
      return {
        isError: Boolean(envelope.result?.isError),
        body: JSON.parse(text) as { status?: number; code?: string },
      };
    };

    const previewed = await invoke(view);
    expect(previewed.isError).toBe(true);
    expect(previewed.body.status).toBe(403);

    // The control: the same tool call, same session, no persona — the owner
    // creates the space.
    const real = await invoke();
    expect(real.isError).toBe(false);
  });

  // ─── 7. The marker is present exactly when the persona validated ──

  it("stamps X-View-As-Active on validated requests only", async () => {
    const view = persona("member", "preset:viewer");

    expect((await listSpaces(view)).headers.get(ACTIVE)).toBe("1");
    expect((await listSpaces()).headers.get(ACTIVE)).toBeNull();

    // A refusal decided UNDER the persona is the persona's, and says so.
    const denied = await createAgent("@view-as/marked", view);
    expect(denied.status).toBe(403);
    expect(denied.headers.get(ACTIVE)).toBe("1");

    // A refusal OF the persona is not: nothing was ever previewed.
    const user = await createTestUser();
    await addOrgMember(owner.orgId, user.id, "member");
    const refused = await app.request("/api/spaces", {
      headers: orgOnlyHeaders(
        { ...owner, user, cookie: user.cookie },
        { "X-View-As": persona("guest") },
      ),
    });
    expect(refused.status).toBe(403);
    expect(refused.headers.get(ACTIVE)).toBeNull();
  });
});
