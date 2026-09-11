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
import { expectProblem } from "../../helpers/assertions.ts";
import { viewAsWire, type ViewAsPersona as ViewAsSnapshot } from "../../../src/lib/view-as.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  memberContext,
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
const SSE_ACCEPT = { Accept: "text/event-stream" };

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

// `view !== undefined`, not a truthiness test: the empty string is a header a
// client can send and one this suite asserts is refused.
function viewHeader(view?: string): Record<string, string> {
  return view !== undefined ? { "X-View-As": view } : {};
}

async function expectJson<T>(response: Response, status = 200): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as T;
}

/**
 * An SSE stream that opened is a 200 whose body has to be released — and never
 * read: an open stream has no end for `.text()` to wait for.
 */
async function expectOpened(response: Response): Promise<Response> {
  expect(response.status, response.status === 200 ? "" : await response.text()).toBe(200);
  await response.body?.cancel();
  return response;
}

async function withFeature(name: string, on: boolean, run: () => Promise<void>): Promise<void> {
  const restore = setFeatureFlag(name, on);
  try {
    await run();
  } finally {
    restore();
  }
}

/** Registers a denial handler that records `pick(ctx)`; the suite's `afterEach` unregisters it. */
function captureDenials<T>(pick: (ctx: PermissionDenialContext) => T): T[] {
  const seen: T[] = [];
  setPermissionDenialHandler((ctx) => {
    seen.push(pick(ctx));
  });
  return seen;
}

function fromContext(ctx: PermissionDenialContext, key: string): unknown {
  return (ctx.c as { get: (key: string) => unknown }).get(key);
}

function agentBody(name: string, displayName: string, description: string) {
  return {
    manifest: {
      name,
      display_name: displayName,
      description,
      schema_version: "0.1",
      version: "0.1.0",
      type: "agent",
    },
    content: "Do the thing",
  };
}

async function libraryAgentIds(headers: Record<string, string>): Promise<string[]> {
  const body = await expectJson<{ packages: { agent: Array<{ id: string }> } }>(
    await app.request("/api/library", { headers }),
  );
  return body.packages.agent.map((pkg) => pkg.id);
}

describe("view as role", () => {
  let owner: TestContext;

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "view-as" });
  });

  afterEach(() => setPermissionDenialHandler(null));

  /** `X-View-As` for a persona in the org's default space. */
  function persona(orgRole: "member" | "guest", role?: string, spaceId = owner.defaultSpaceId) {
    return role === undefined
      ? `org_role=${orgRole}`
      : `org_role=${orgRole}; space=${spaceId}; role=${role}`;
  }

  interface Call {
    method?: string;
    body?: unknown;
    view?: string;
    /** `X-Space-Id`; omitted for org-only routes. */
    space?: string;
    ctx?: TestContext;
    headers?: Record<string, string>;
  }

  /** A session request under the org context, optionally in a space and under a persona. */
  function request(path: string, call: Call = {}) {
    const hasBody = call.body !== undefined;
    return app.request(path, {
      method: call.method ?? (hasBody ? "POST" : "GET"),
      headers: orgOnlyHeaders(call.ctx ?? owner, {
        ...viewHeader(call.view),
        ...(call.space ? { "X-Space-Id": call.space } : {}),
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...call.headers,
      }),
      body: hasBody ? JSON.stringify(call.body) : undefined,
    });
  }

  const listSpaces = (view?: string) => request("/api/spaces", { view });

  async function listedSpaces(view?: string): Promise<ListedSpace[]> {
    return (await expectJson<{ data: ListedSpace[] }>(await listSpaces(view))).data;
  }

  async function listedOrgs(path: string, view?: string, ctx?: TestContext): Promise<ListedOrg[]> {
    return (await expectJson<{ data: ListedOrg[] }>(await request(path, { view, ctx }))).data;
  }

  function createAgent(name: string, view?: string) {
    return request("/api/packages/agents", {
      view,
      space: owner.defaultSpaceId,
      body: agentBody(name, "Preview probe", "Written to prove the persona is enforced on writes"),
    });
  }

  function space(name: string, visibility: "private" | "closed") {
    return seedSpace({ orgId: owner.orgId, name, visibility });
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
    const privateSpace = await space("Private", "private");
    const view = persona("guest");

    expect(await listedSpaces(view)).toEqual([]);
    expect((await listedSpaces()).map((s) => s.id).sort()).toEqual(
      [owner.defaultSpaceId, privateSpace.id].sort(),
    );

    const inSpace = (spaceId: string, view?: string) =>
      request("/api/agents", { space: spaceId, view });

    // An open space the guest was never added to is a 403; a private one does
    // not exist for them at all.
    await expectProblem(await inSpace(owner.defaultSpaceId, view), 403, {
      code: "not_a_space_member",
    });
    // The persona's own wall, answered AS the persona — the generic code and
    // the active marker. This is what `view_as_not_found` has to be told apart
    // from, or a client would end the preview every time it 404s.
    const hidden = await inSpace(privateSpace.id, view);
    await expectProblem(hidden, 404, { code: "not_found" });
    expect(hidden.headers.get(ACTIVE)).toBe("1");

    expect((await inSpace(owner.defaultSpaceId)).status).toBe(200);
    expect((await inSpace(privateSpace.id)).status).toBe(200);
  });

  // ─── 3. The persona only ever removes ─────────────────────────────

  it("never grants a permission the real caller lacks, custom bundles included", async () => {
    await withFeature("custom_roles", true, async () => {
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
      const [previewedOrg] = await listedOrgs("/api/orgs", view);
      const [realOrg] = await listedOrgs("/api/orgs");
      expect(previewedOrg?.role).toBe("member");
      expect(realOrg?.role).toBe("owner");
      expect(realOrg?.permissions).toContain("members:remove");
      expect(previewedOrg?.permissions).not.toContain("members:remove");
      const realOrgPermissions = new Set(realOrg?.permissions);
      expect(previewedOrg?.permissions.filter((p) => !realOrgPermissions.has(p))).toEqual([]);
    });
  });

  // ─── 4. Refusals, never a fall-back ───────────────────────────────

  describe("refusals", () => {
    it("names the persona on a denial decided UNDER a preview", async () => {
      // `installPermissionAuditLogger` is what production registers; the fields
      // it logs are asserted here through the same seam it uses.
      const records = captureDenials((ctx) => {
        const p = fromContext(ctx, "viewAs") as ViewAsSnapshot | undefined;
        return {
          required: ctx.required,
          role: fromContext(ctx, "orgRole"),
          viewAs: p ? viewAsWire(p) : undefined,
        };
      });
      // A disjunction refusal, which is the shape that reaches the hook
      // outside `makePermissionGuard`.
      const refused = await request(`/api/spaces/${owner.defaultSpaceId}/roles`, {
        view: persona("member", "preset:builder"),
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
    });

    it("refuses a caller who is neither owner nor admin, and audits the attempt", async () => {
      const denials = captureDenials((ctx) => ctx.required);
      const asMember = await memberContext(owner, "member");

      const refused = await request("/api/spaces", { ctx: asMember, view: persona("guest") });
      await expectProblem(refused, 403, { code: "view_as_forbidden" });
      expect(denials).toEqual(["view_as:guest"]);

      // The same caller without the header still reads its own spaces.
      expect((await request("/api/spaces", { ctx: asMember })).status).toBe(200);
    });

    it("refuses a credential that cannot carry a persona", async () => {
      const key = await seedApiKey({
        orgId: owner.orgId,
        spaceId: owner.defaultSpaceId,
        createdBy: owner.user.id,
        scopes: ["spaces:read"],
      });
      const withKey = (view?: string) =>
        app.request("/api/spaces", {
          headers: { Authorization: `Bearer ${key.rawKey}`, ...viewHeader(view) },
        });

      await expectProblem(await withKey(persona("member", "preset:viewer")), 400, {
        code: "view_as_unsupported",
      });
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
      await expectProblem(await listSpaces(header), 400, { code: "invalid_view_as" });
    });

    it("refuses a persona this listing cannot place", async () => {
      const view = persona("member", "preset:viewer");
      const orgs = (headers: Record<string, string>) =>
        app.request("/api/orgs", { headers: { Cookie: owner.cookie, ...headers } });

      // No `X-Org-Id`: the listings are exempt from org context, so nothing
      // names the org the role is previewed in.
      await expectProblem(await orgs(viewHeader(view)), 400, { code: "invalid_view_as" });

      // An org the caller is not a member of matches no row to narrow.
      const other = await createTestContext({ orgSlug: "view-as-stranger" });
      const stranger = await orgs({ "X-Org-Id": other.orgId, ...viewHeader(view) });
      await expectProblem(stranger, 404, { code: "view_as_not_found" });

      // Control: the same header with the caller's own org is answered.
      const placed = await request("/api/orgs", { view });
      expect(placed.status).toBe(200);
      expect(placed.headers.get(ACTIVE)).toBe("1");
    });

    it("refuses a malformed space id at the header, not at some later field", async () => {
      const malformed = await listSpaces("org_role=member; space=app_legacy; role=preset:viewer");
      await expectProblem(malformed, 400, { code: "invalid_view_as", param: "X-View-As" });
      // Control: the same request with a well-shaped id gets past parsing.
      expect((await listSpaces(persona("member", "preset:viewer"))).status).toBe(200);
    });

    it("refuses a space that is not in the organization", async () => {
      const other = await createTestContext({ orgSlug: "view-as-other" });
      const response = await listSpaces(persona("member", "preset:viewer", other.defaultSpaceId));
      // Its OWN code, not the generic `not_found`: this is the preview dying,
      // not the previewed role failing to find something. A client cannot tell
      // "drop the persona" from "this row does not exist for you" otherwise.
      await expectProblem(response, 404, { code: "view_as_not_found" });
      expect((await listSpaces()).status).toBe(200);
    });

    it("refuses a custom role that belongs to another organization", async () => {
      await withFeature("custom_roles", true, async () => {
        const other = await createTestContext({ orgSlug: "view-as-foreign" });
        const foreign = await seedSpaceRole({ orgId: other.orgId, key: "foreign" });
        const refused = await listSpaces(persona("member", `custom:${foreign.id}`));
        await expectProblem(refused, 404, { code: "view_as_not_found" });
        const mine = await seedSpaceRole({ orgId: owner.orgId, key: "mine" });
        expect((await listSpaces(persona("member", `custom:${mine.id}`))).status).toBe(200);
      });
    });

    it("refuses a custom role where the custom_roles feature is off", async () => {
      const role = await seedSpaceRole({ orgId: owner.orgId, key: "ungated" });
      await withFeature("custom_roles", false, async () => {
        const response = await listSpaces(persona("member", `custom:${role.id}`));
        // A view-as refusal, not the role routes' `feature_unavailable`: every
        // way a persona is turned down must be a code the client drops it on.
        await expectProblem(response, 403, { code: "view_as_forbidden" });
        // A preset preview stays available on the same deployment.
        expect((await listSpaces(persona("member", "preset:viewer"))).status).toBe(200);
      });
    });
  });

  // ─── The other two surfaces the SPA gates on ──────────────────────

  it("narrows GET /api/me/orgs for the previewed org and no other", async () => {
    const other = await createTestContext({ orgSlug: "view-as-second" });
    await addOrgMember(other.orgId, owner.user.id, "owner");
    const view = persona("member", "preset:viewer");

    const previewed = await listedOrgs("/api/me/orgs", view);
    const previewedHere = previewed.find((org) => org.id === owner.orgId);
    const previewedThere = previewed.find((org) => org.id === other.orgId);
    expect(previewedHere?.role).toBe("member");
    expect(previewedHere?.permissions).not.toContain("members:remove");
    // `X-Org-Id` named the first org, so the second is untouched: a preview is
    // validated in one organization and applies only there.
    expect(previewedThere?.role).toBe("owner");
    expect(previewedThere?.permissions).toContain("members:remove");

    const real = await listedOrgs("/api/me/orgs");
    expect(real.find((org) => org.id === owner.orgId)?.role).toBe("owner");
  });

  it("offers only the roles the persona could assign", async () => {
    const roles = (view?: string) => request(`/api/spaces/${owner.defaultSpaceId}/roles`, { view });

    // Preset `builder` holds no `space-members:*`, so the roles catalogue is
    // not even readable — the same wall a real builder hits.
    expect((await roles(persona("member", "preset:builder"))).status).toBe(403);

    // Preset `admin` reads it, but a role is only offered if the persona itself
    // holds every permission in it.
    const asSpaceAdmin = await roles(persona("member", "preset:admin"));
    const offered = (await expectJson<{ data: Array<{ key: string }> }>(asSpaceAdmin)).data.map(
      (role) => role.key,
    );
    expect(asSpaceAdmin.headers.get(ACTIVE)).toBe("1");
    expect(offered).toEqual(expect.arrayContaining(["admin", "builder", "operator", "viewer"]));

    const real = await roles();
    expect(real.status).toBe(200);
    expect(real.headers.get(ACTIVE)).toBeNull();
  });

  // ─── 5. Audit names the persona and keeps the real actor ──────────

  it("records the persona on a write made under preview", async () => {
    const view = persona("member", "preset:admin");
    const patch = (view?: string) =>
      request(`/api/spaces/${owner.defaultSpaceId}`, {
        method: "PATCH",
        view,
        body: { name: view ? "Renamed under preview" : "Renamed for real" },
      });

    expect((await patch(view)).status).toBe(200);
    expect((await patch()).status).toBe(200);

    const rows = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, owner.orgId), eq(auditEvents.action, "space.updated")));
    const renamedTo = (needle: string) =>
      rows.find((row) => (row.after as { name?: string }).name?.includes(needle));
    const previewed = renamedTo("preview");
    const real = renamedTo("real");

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
    it("refuses the org-member policies a previewed member cannot reach", async () => {
      const target = await createTestUser();
      await addOrgMember(owner.orgId, target.id, "member");
      const view = persona("member", "preset:admin");
      const memberPath = `/api/orgs/${owner.orgId}/members/${target.id}`;

      const changeRole = (view?: string) =>
        request(memberPath, { method: "PUT", view, body: { role: "admin" } });
      expect((await changeRole(view)).status).toBe(403);
      expect((await changeRole()).status).toBe(200);

      const remove = (view?: string) => request(memberPath, { method: "DELETE", view });
      expect((await remove(view)).status).toBe(403);
      expect((await remove()).status).toBe(204);
    });

    it("refuses the space catalog writes a previewed member cannot reach", async () => {
      const view = persona("member", "preset:admin");

      const create = (view?: string) =>
        request("/api/spaces", { view, body: { name: view ? "Under preview" : "For real" } });
      // `spaces:write` is org-level and admin-tier: preset `admin` in a space
      // does not buy it, which is the whole point of the two-layer model.
      expect((await create(view)).status).toBe(403);
      const createdId = (await expectJson<{ id: string }>(await create(), 201)).id;

      const remove = (view?: string) =>
        request(`/api/spaces/${createdId}`, { method: "DELETE", view });
      expect((await remove(view)).status).toBe(403);
      expect((await remove()).status).toBe(204);
    });

    it("answers the package catalog as a member would, not as the org catalog admin", async () => {
      // Installed in no space: only someone who manages the ORG catalog sees it.
      await seedAgent({ id: "@view-as/uninstalled", orgId: owner.orgId });
      const library = (view?: string) => libraryAgentIds(orgOnlyHeaders(owner, viewHeader(view)));

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
      const listedFor = async (ctx: TestContext, view?: string) =>
        (await listedOrgs("/api/orgs", view, ctx)).find((org) => org.id === ctx.orgId)
          ?.permissions ?? [];

      // A REAL member of the org holds the probe — this is what the persona is
      // claiming to show.
      expect(await listedFor(await memberContext(owner, "member"))).toContain(ORG_PROBE);

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
    const vault = await seedSpace({ orgId: source.orgId, name: "Vault", visibility: "private" });
    await seedSpaceMember({ spaceId: vault.id, userId: owner.user.id, presetRole: "builder" });

    const created = await request("/api/packages/agents", {
      ctx: source,
      space: source.defaultSpaceId,
      body: agentBody("@view-as-source/shared", "Shared", "Lives in another organization"),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    await seedInstalledPackage(vault.id, "@view-as-source/shared");

    // Persona `builder` in the previewing owner's OWN org, so the write half of
    // the fork is satisfied there and the only question left is the source org.
    const fork = (view?: string) =>
      request("/api/packages/@view-as-source/shared/fork", {
        view,
        space: owner.defaultSpaceId,
        body: { name: view ? "under-preview" : "for-real" },
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

    /** The runs stream for `ctx`, carrying the persona as the `view_as` query parameter. */
    function stream(opts: { spaceId?: string; view?: string; ctx?: TestContext } = {}) {
      const ctx = opts.ctx ?? owner;
      const query =
        `orgId=${ctx.orgId}&spaceId=${opts.spaceId ?? ctx.defaultSpaceId}` +
        (opts.view !== undefined ? `&view_as=${encodeURIComponent(opts.view)}` : "");
      return app.request(`/api/realtime/runs?${query}`, {
        headers: { Cookie: ctx.cookie, ...SSE_ACCEPT },
      });
    }

    it("stops a previewed guest at the same wall the HTTP pipeline does", async () => {
      const privateSpace = await space("Private", "private");
      const view = persona("guest");

      const open = await stream({ view });
      await expectProblem(open, 403, { code: "not_a_space_member" });
      expect(open.headers.get(ACTIVE)).toBe("1");

      expect((await stream({ spaceId: privateSpace.id, view })).status).toBe(404);

      // Control: the same two streams without the persona are the owner's.
      const asOwner = await expectOpened(await stream());
      expect(asOwner.headers.get(ACTIVE)).toBeNull();
      await expectOpened(await stream({ spaceId: privateSpace.id }));
    });

    it("opens for a previewed viewer but withholds the debug frames the role cannot see", async () => {
      const agentPkg = await seedAgent({ orgId: owner.orgId });
      const run = await seedRun({
        packageId: agentPkg.id,
        orgId: owner.orgId,
        spaceId: owner.defaultSpaceId,
        // A previewed `viewer` holds `runs:read` and not `read-all`, so the
        // frames it may see at all are the previewer's own runs.
        userId: owner.user.id,
      });

      const response = await stream({ view: persona("member", "preset:viewer") });
      expect(response.status).toBe(200);
      expect(response.headers.get(ACTIVE)).toBe("1");

      // `runs:delete` is what gates debug-level frames, and a viewer has none.
      const log = (level: string, message: string) =>
        pgNotify("run_log_insert", {
          org_id: owner.orgId,
          space_id: owner.defaultSpaceId,
          run_id: run.id,
          user_id: owner.user.id,
          level,
          message,
        });
      await wait();
      await log("debug", "debug-secret");
      await wait();
      await log("info", "info-visible");
      const events = await collectSSEEvents(response.body!, 1, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.data).message).toBe("info-visible");
    });

    it("refuses the persona as a header, pointing at the query parameter", async () => {
      const view = persona("member", "preset:viewer");
      const refused = await app.request(
        `/api/realtime/runs?orgId=${owner.orgId}&spaceId=${owner.defaultSpaceId}`,
        { headers: { Cookie: owner.cookie, ...SSE_ACCEPT, ...viewHeader(view) } },
      );
      const body = await expectProblem(refused, 400, { code: "invalid_view_as" });
      expect(body.detail).toContain("view_as");
      // Control: the same persona as the query parameter opens the stream.
      await expectOpened(await stream({ view }));
    });

    it("audits an ineligible caller's attempt with the actor that made it", async () => {
      const seen = captureDenials((ctx) => ({
        required: ctx.required,
        actorId: (fromContext(ctx, "user") as { id: string } | undefined)?.id,
        orgId: fromContext(ctx, "orgId") as string | undefined,
        role: fromContext(ctx, "orgRole") as string | undefined,
      }));
      const user = await createTestUser();
      await addOrgMember(owner.orgId, user.id, "member");
      const refused = await stream({
        ctx: { ...owner, cookie: user.cookie },
        view: persona("guest"),
      });
      await expectProblem(refused, 403, { code: "view_as_forbidden" });
      // A denial record naming no actor is not a record: these routes run
      // outside the pipeline, so nothing else would have put them on the
      // context.
      expect(seen).toEqual([
        { required: "view_as:guest", actorId: user.id, orgId: owner.orgId, role: "member" },
      ]);
    });

    it("refuses a malformed persona on the query parameter", async () => {
      await expectProblem(await stream({ view: "org_role=owner" }), 400, {
        code: "invalid_view_as",
      });
      await expectOpened(await stream());
    });

    it("refuses a persona on a credential that cannot carry one", async () => {
      const key = await seedApiKey({
        orgId: owner.orgId,
        spaceId: owner.defaultSpaceId,
        createdBy: owner.user.id,
        scopes: ["runs:read"],
      });
      const withKey = (query = "") => app.request(`/api/realtime/runs?token=${key.rawKey}${query}`);

      const refused = await withKey(`&view_as=${encodeURIComponent(persona("guest"))}`);
      await expectProblem(refused, 400, { code: "view_as_unsupported" });
      await expectOpened(await withKey());
    });
  });

  // ─── B2. The chat module's in-process loopback carries it ─────────

  describe("chat in-process loopback", () => {
    /** What `chat-stream.ts` forwards: the caller's already-resolved set. */
    const SCOPE = ["spaces:read", "agents:read", "skills:read"] as const;

    function loopbackHeaders(orgRole: string, viewAs?: unknown): Record<string, string> {
      const token = mintMcpLoopbackToken({
        userId: owner.user.id,
        email: owner.user.email,
        name: owner.user.name,
        orgId: owner.orgId,
        orgRole,
        permissions: [...SCOPE],
        viewAs,
      });
      return { Authorization: `Bearer ${token}`, "X-Org-Id": owner.orgId };
    }

    const libraryOverLoopback = (orgRole: string, viewAs?: unknown) =>
      libraryAgentIds(loopbackHeaders(orgRole, viewAs));

    it("reaches a closed space the persona is a member of, and only with the claim", async () => {
      // A CLOSED space reaches nobody without a row, so what the hop sees there
      // depends on the persona's overlay and on nothing else.
      const closed = await space("Closed", "closed");
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
        headers: loopbackHeaders("owner", { orgId: foreign.orgId, orgRole: "member", space: null }),
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
    const invoke = async (view?: string) => {
      const envelope = await expectJson<{
        result?: { isError?: boolean; content?: Array<{ text: string }> };
      }>(
        await request(`/api/mcp/o/${owner.orgId}`, {
          view,
          space: owner.defaultSpaceId,
          headers: { Accept: "application/json, text/event-stream" },
          body: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "invoke_operation",
              arguments: {
                operation_id: "createSpace",
                body: { name: view ? "Via preview" : "Via owner" },
              },
            },
          },
        }),
      );
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
    const refused = await request("/api/spaces", {
      ctx: await memberContext(owner, "member"),
      view: persona("guest"),
    });
    expect(refused.status).toBe(403);
    expect(refused.headers.get(ACTIVE)).toBeNull();
  });
});
