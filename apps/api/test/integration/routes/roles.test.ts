// SPDX-License-Identifier: Apache-2.0

/**
 * Custom space roles — `/api/roles` (RBAC spec §6.2, §12.1).
 *
 * Every refusal here is paired with the permitted twin that differs by exactly
 * the thing under test (`verification-must-discriminate`): the feature flag is
 * asserted OFF and ON in the same file, an unknown permission next to a known
 * one, a preset key next to a free one.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getTestApp, setFeatureFlag } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { expectProblem } from "../../helpers/assertions.ts";
import { SPACE_ROLE_PRESETS } from "@appstrate/core/permissions";
import {
  addOrgMember,
  authHeaders,
  createTestContext,
  createTestUser,
  memberContext,
  orgOnlyHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedInstalledPackage,
  seedPackage,
  seedSpaceMember,
  seedSpaceRole,
} from "../../helpers/seed.ts";

const app = getTestApp();

interface RoleWire {
  object: "role";
  kind: "preset" | "custom";
  id: string | null;
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
  unavailable_permissions: string[];
}

describe("custom space roles", () => {
  let owner: TestContext;
  let restoreFlag: () => void;

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "roles" });
    restoreFlag = setFeatureFlag("custom_roles", true);
  });

  afterEach(() => {
    restoreFlag();
  });

  const flag = (on: boolean) => {
    restoreFlag();
    restoreFlag = setFeatureFlag("custom_roles", on);
  };

  /** Org-scoped request as `ctx` (owner by default); a body is sent as JSON. */
  const req = (method: string, path: string, body?: unknown, ctx: TestContext = owner) =>
    app.request(path, {
      method,
      headers: {
        ...orgOnlyHeaders(ctx),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const post = (body: unknown, ctx: TestContext = owner) => req("POST", "/api/roles", body, ctx);
  const patch = (id: string, body: unknown) => req("PATCH", `/api/roles/${id}`, body);
  const del = (id: string, ctx: TestContext = owner) =>
    req("DELETE", `/api/roles/${id}`, undefined, ctx);

  /** Statuses of the two read routes, `[list, vocabulary]`. */
  const reads = async (ctx: TestContext) => [
    (await req("GET", "/api/roles", undefined, ctx)).status,
    (await req("GET", "/api/roles/vocabulary", undefined, ctx)).status,
  ];

  const validBody = (over: Record<string, unknown> = {}) => ({
    key: "support",
    name: "Support",
    permissions: ["agents:read", "runs:read"],
    ...over,
  });

  const createRole = async (over: Record<string, unknown>) => {
    const created = await post(validBody(over));
    expect(created.status).toBe(201);
    return (await created.json()) as RoleWire & { id: string };
  };

  /** Invite a guest into the default space with `customRoleId` assigned. */
  const invite = (customRoleId: string) =>
    req("POST", `/api/orgs/${owner.orgId}/members`, {
      email: `invitee-${crypto.randomUUID().slice(0, 8)}@test.com`,
      role: "guest",
      space_assignments: [{ space_id: owner.defaultSpaceId, custom_role_id: customRoleId }],
    });

  describe("GET /api/roles", () => {
    it("lists every preset with its permissions, then the org's own bundles", async () => {
      const custom = await seedSpaceRole({ orgId: owner.orgId, key: "support", name: "Support" });
      const res = await req("GET", "/api/roles");
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: RoleWire[] };

      // The literal list, in order: comparing against the constant the route
      // reads would pass on any list the constant happens to hold.
      expect(data.filter((r) => r.kind === "preset").map((r) => r.key)).toEqual([
        "admin",
        "builder",
        "operator",
        "runner",
        "viewer",
      ]);
      // Presets carry their permission list and no id — they are not rows.
      const viewer = data.find((r) => r.key === "viewer")!;
      expect(viewer.id).toBeNull();
      expect(viewer.permissions).toContain("agents:read");
      expect(viewer.permissions).not.toContain("agents:run");

      const listed = data.find((r) => r.kind === "custom")!;
      expect(listed.id).toBe(custom.id);
      expect(listed.permissions).toEqual(["agents:read"]);
    });

    it("separates what a bundle grants from what it merely spells, and round-trips", async () => {
      // A write refuses an unknown string, so this row is what a module leaving
      // `MODULES` leaves behind. The listing must not report it as a grant —
      // enforcement (`spacePermissions`) already drops it — and must not hide
      // it either, or a bundle degraded by a module removal reads as merely
      // shorter. And the array it reports has to be one a PATCH accepts back.
      const stale = await seedSpaceRole({
        orgId: owner.orgId,
        key: "stale",
        permissions: ["agents:read", "ghostmodule:write"],
      });
      const allGhosts = await seedSpaceRole({
        orgId: owner.orgId,
        key: "all-ghosts",
        permissions: ["ghostmodule:write"],
      });

      const { data } = (await (await req("GET", "/api/roles")).json()) as { data: RoleWire[] };
      const listed = data.find((r) => r.id === stale.id)!;
      expect(listed.permissions).toEqual(["agents:read"]);
      expect(listed.unavailable_permissions).toEqual(["ghostmodule:write"]);
      // Granting nothing is a legible state, not an empty role.
      const degraded = data.find((r) => r.id === allGhosts.id)!;
      expect(degraded.permissions).toEqual([]);
      expect(degraded.unavailable_permissions).toEqual(["ghostmodule:write"]);
      // A preset is code, so it can spell nothing this deployment lacks.
      expect(data.find((r) => r.key === "viewer")!.unavailable_permissions).toEqual([]);

      // The permitted twin of the 400 below: what was listed is accepted back,
      // and accepting it is what drops the ghost from the row.
      const echoed = await patch(stale.id, { permissions: listed.permissions });
      expect(echoed.status).toBe(200);
      const saved = (await echoed.json()) as RoleWire;
      expect(saved.permissions).toEqual(["agents:read"]);
      expect(saved.unavailable_permissions).toEqual([]);
      // …and the string that is NOT listed as a grant is still refused, so the
      // round-trip comes from the projection agreeing, not validation going soft.
      await expectProblem(await patch(stale.id, { permissions: ["ghostmodule:write"] }), 400, {
        param: "permissions",
      });
    });

    it("does not list another org's bundles", async () => {
      const other = await createTestContext({ orgSlug: "roles-other" });
      await seedSpaceRole({ orgId: other.orgId, key: "foreign" });
      const res = await req("GET", "/api/roles");
      const { data } = (await res.json()) as { data: RoleWire[] };
      expect(data.filter((r) => r.kind === "custom")).toEqual([]);
    });

    it("an org member reads the catalog but cannot define a bundle", async () => {
      // A space `admin` is often only an org `member`; assigning a role means
      // seeing what is assignable. Defining one stays owner/admin.
      const asMember = await memberContext(owner, "member");
      expect(await reads(asMember)).toEqual([200, 200]);
      expect((await post(validBody(), asMember)).status).toBe(403);
    });

    it("a guest reads nothing — roles are the org's own vocabulary", async () => {
      const asGuest = await memberContext(owner, "guest");
      expect(await reads(asGuest)).toEqual([403, 403]);
      // The control: the same two requests from the owner.
      expect(await reads(owner)).toEqual([200, 200]);
    });
  });

  describe("GET /api/roles/vocabulary", () => {
    it("offers exactly what the validator accepts, grouped by resource", async () => {
      const res = await req("GET", "/api/roles/vocabulary");
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as {
        data: {
          resource: string;
          permissions: {
            permission: string;
            action: string;
            api_key_grantable: boolean;
          }[];
        }[];
      };

      const flat = data.flatMap((g) => g.permissions);
      const offered = flat.map((p) => p.permission);
      // Space-level only: an org-level string must not be offerable.
      expect(offered).toContain("agents:write");
      expect(offered).not.toContain("members:invite");
      expect(offered).not.toContain("roles:write");

      // Grantability is the API-key allowlist, not a second hand-kept table:
      // `integrations:configure` is deliberately session-only.
      const byName = new Map(flat.map((p) => [p.permission, p]));
      expect(byName.get("agents:run")!.api_key_grantable).toBe(true);
      expect(byName.get("integrations:configure")!.api_key_grantable).toBe(false);
      expect(byName.get("agents:read")!.action).toBe("read");

      // And every offered string is accepted by the create route.
      expect((await post(validBody({ permissions: offered }))).status).toBe(201);
    });
  });

  describe("POST /api/roles validation", () => {
    it("refuses an unknown permission, naming it, and accepts the known twin", async () => {
      const bad = await post(validBody({ permissions: ["agents:read", "agents:teleport"] }));
      const problem = await expectProblem(bad, 400, { param: "permissions" });
      expect(problem.detail).toContain("agents:teleport");

      expect((await post(validBody())).status).toBe(201);
    });

    it("refuses an ORG-level permission — a space role can only hold space strings", async () => {
      const res = await post(validBody({ permissions: ["members:invite"] }));
      expect((await expectProblem(res, 400)).detail).toContain("members:invite");
    });

    it("refuses an empty permission list", async () => {
      await expectProblem(await post(validBody({ permissions: [] })), 400, {
        param: "permissions",
      });
    });

    it("stores each permission once, and refuses a list longer than the vocabulary", async () => {
      // Duplicates are what let a body name one permission in an unbounded
      // number of entries, and the stored array is re-walked on every request
      // of every holder — so the ceiling is the vocabulary, and it is the
      // vocabulary the route reports, not a number this test restates.
      const { data } = (await (await req("GET", "/api/roles/vocabulary")).json()) as {
        data: { permissions: { permission: string }[] }[];
      };
      const size = data.flatMap((g) => g.permissions).length;

      const atCeiling = Array.from({ length: size }, () => "agents:read");
      const created = await post(validBody({ key: "at-ceiling", permissions: atCeiling }));
      expect(created.status).toBe(201);
      expect(((await created.json()) as RoleWire).permissions).toEqual(["agents:read"]);

      // One entry more than the whole vocabulary can only be duplicates.
      const over = await post(
        validBody({ key: "over-ceiling", permissions: [...atCeiling, "agents:read"] }),
      );
      expect((await expectProblem(over, 400, { param: "permissions" })).detail).toContain(
        String(size),
      );
    });

    it("refuses every preset key and accepts a free one", async () => {
      // Reserved by the code guard AND by `space_roles_key_not_preset`; a
      // preset the constraint does not list would answer 201 here and shadow
      // the built-in in the role catalog.
      for (const preset of SPACE_ROLE_PRESETS) {
        const problem = await expectProblem(await post(validBody({ key: preset })), 400, {
          param: "key",
        });
        expect(problem.detail).toContain(preset);
      }

      expect((await post(validBody({ key: "builders" }))).status).toBe(201);
    });

    it("refuses a key that is not a slug", async () => {
      expect((await post(validBody({ key: "Support Team" }))).status).toBe(400);
    });

    it("409 role_key_taken on a collision within the org, but not across orgs", async () => {
      expect((await post(validBody())).status).toBe(201);
      await expectProblem(await post(validBody({ name: "Support 2" })), 409, {
        code: "role_key_taken",
      });

      const other = await createTestContext({ orgSlug: "roles-sibling" });
      expect((await post(validBody(), other)).status).toBe(201);
    });
  });

  describe("PATCH / DELETE scoping", () => {
    it("another org's role is a 404 on PATCH and on DELETE", async () => {
      const other = await createTestContext({ orgSlug: "roles-foreign" });
      const foreign = await seedSpaceRole({ orgId: other.orgId, key: "foreign" });

      expect((await patch(foreign.id, { name: "Stolen" })).status).toBe(404);
      expect((await del(foreign.id)).status).toBe(404);

      // The control: its own org reaches it.
      expect((await del(foreign.id, other)).status).toBe(204);
    });

    it("a malformed role id is a 400 naming the field, not a 404", async () => {
      await expectProblem(await del("rol_nope"), 400, { param: "id" });
    });

    it("PATCH re-scopes the bundle and validates the new permissions", async () => {
      const role = await seedSpaceRole({ orgId: owner.orgId, key: "support" });
      expect((await patch(role.id, { permissions: ["agents:teleport"] })).status).toBe(400);

      const ok = await patch(role.id, {
        name: "Support",
        permissions: ["agents:read", "agents:run"],
      });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as RoleWire;
      expect(body.name).toBe("Support");
      expect(body.permissions).toEqual(["agents:read", "agents:run"]);
    });
  });

  describe("DELETE while assigned", () => {
    it("409 role_in_use carries the member count; deleting an unassigned twin works", async () => {
      const held = await seedSpaceRole({ orgId: owner.orgId, key: "held" });
      const free = await seedSpaceRole({ orgId: owner.orgId, key: "free" });
      const user = await createTestUser();
      await addOrgMember(owner.orgId, user.id, "guest");
      await seedSpaceMember({
        spaceId: owner.defaultSpaceId,
        userId: user.id,
        presetRole: null,
        customRoleId: held.id,
      });

      const problem = await expectProblem(await del(held.id), 409, { code: "role_in_use" });
      expect(problem.member_count).toBe(1);
      expect(problem.pending_invitation_count).toBe(0);

      expect((await del(free.id)).status).toBe(204);
    });

    it("409s on a PENDING invitation that assigns it, with zero members", async () => {
      // The assignments are JSONB, so no FK holds this one — without the count
      // the role would vanish and the invitee would accept into nothing.
      const role = await createRole({ key: "promised" });
      expect((await invite(role.id)).status).toBe(201);

      const problem = await expectProblem(await del(role.id), 409, { code: "role_in_use" });
      expect(problem.member_count).toBe(0);
      expect(problem.pending_invitation_count).toBe(1);

      // The control: an invitation naming ANOTHER role does not hold this one.
      const other = await createRole({ key: "unpromised" });
      expect((await del(other.id)).status).toBe(204);
    });
  });

  describe("features.custom_roles gate", () => {
    it("authoring 403s without the flag and succeeds with it", async () => {
      const role = await seedSpaceRole({ orgId: owner.orgId, key: "support" });
      flag(false);

      await expectProblem(await post(validBody({ key: "gated" })), 403, {
        code: "feature_unavailable",
      });
      expect((await patch(role.id, { name: "Nope" })).status).toBe(403);

      // Reading never depends on the flag — the presets and the existing
      // bundles stay visible in OSS.
      expect(await reads(owner)).toEqual([200, 200]);

      // The control: the same two calls with the flag back on.
      flag(true);
      expect((await post(validBody({ key: "gated" }))).status).toBe(201);
      expect((await patch(role.id, { name: "Yes" })).status).toBe(200);
    });

    it("granting a bundle 403s without the flag, on every path that grants one", async () => {
      const role = await createRole({ key: "support", permissions: ["agents:read"] });
      const target = await memberContext(owner, "guest");
      const spacePath = `/api/spaces/${owner.defaultSpaceId}/members`;
      flag(false);

      await expectProblem(
        await req("POST", spacePath, { userId: target.user.id, custom_role_id: role.id }),
        403,
        { code: "feature_unavailable" },
      );
      await expectProblem(await invite(role.id), 403, { code: "feature_unavailable" });

      // The discriminator is the BUNDLE, not the route: a preset goes through
      // the same two calls untouched.
      expect(
        (await req("POST", spacePath, { userId: target.user.id, preset_role: "viewer" })).status,
      ).toBe(201);
      expect(
        (await req("PATCH", `${spacePath}/${target.user.id}`, { custom_role_id: role.id })).status,
      ).toBe(403);
      expect(
        (await req("PATCH", `${spacePath}/${target.user.id}`, { preset_role: "operator" })).status,
      ).toBe(200);

      // The control: the same custom grant with the flag back on.
      flag(true);
      expect(
        (await req("PATCH", `${spacePath}/${target.user.id}`, { custom_role_id: role.id })).status,
      ).toBe(200);
    });

    it("stops offering an ungrantable bundle in the space catalog, still lists it in the org one", async () => {
      const role = await createRole({ key: "support", permissions: ["agents:read"] });
      const catalog = async () => {
        const res = await req("GET", `/api/spaces/${owner.defaultSpaceId}/roles`);
        expect(res.status).toBe(200);
        return ((await res.json()) as { data: RoleWire[] }).data;
      };
      const orgCatalog = async () => {
        const res = await req("GET", "/api/roles");
        return ((await res.json()) as { data: RoleWire[] }).data;
      };

      expect((await catalog()).some((r) => r.id === role.id)).toBe(true);

      flag(false);
      const offered = await catalog();
      expect(offered.some((r) => r.id === role.id)).toBe(false);
      // The presets are the control: the listing itself did not go empty.
      expect(offered.map((r) => r.key)).toEqual([...SPACE_ROLE_PRESETS]);
      // The org catalogue is where a leftover is found and deleted, so it keeps it.
      expect((await orgCatalog()).some((r) => r.id === role.id)).toBe(true);
    });

    it("lets a leftover bundle be cleaned up with the flag off", async () => {
      const role = await createRole({ key: "support", permissions: ["agents:read"] });
      const target = await memberContext(owner, "guest");
      const spacePath = `/api/spaces/${owner.defaultSpaceId}/members`;
      expect(
        (await req("POST", spacePath, { userId: target.user.id, custom_role_id: role.id })).status,
      ).toBe(201);
      flag(false);

      // Held: DELETE names how many holders stand in the way rather than 403ing
      // on the feature.
      await expectProblem(await del(role.id), 409, { code: "role_in_use" });
      // Moving the holder onto a preset is the un-gated half of assignment.
      expect(
        (await req("PATCH", `${spacePath}/${target.user.id}`, { preset_role: "viewer" })).status,
      ).toBe(200);
      expect((await del(role.id)).status).toBe(204);
    });
  });

  describe("a custom role is assignable and grants exactly its permissions", () => {
    beforeEach(async () => {
      await seedPackage({ orgId: owner.orgId, id: "@roles/agent", type: "agent" });
      await seedInstalledPackage(owner.defaultSpaceId, "@roles/agent");
    });

    const runAgent = (ctx: TestContext) =>
      app.request("/api/agents/@roles/agent/run", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ input: {} }),
      });

    it("through POST /api/spaces/:id/members, a read-only bundle reads but cannot run", async () => {
      const role = await createRole({ key: "reader", permissions: ["agents:read"] });

      const asGuest = await memberContext(owner, "guest");
      const assigned = await req("POST", `/api/spaces/${owner.defaultSpaceId}/members`, {
        userId: asGuest.user.id,
        custom_role_id: role.id,
      });
      expect(assigned.status).toBe(201);
      expect((await app.request("/api/agents", { headers: authHeaders(asGuest) })).status).toBe(
        200,
      );

      const ran = await runAgent(asGuest);
      expect((await expectProblem(ran, 403)).detail).toContain("agents:run");

      // The control: the same bundle plus `agents:run` clears that guard —
      // so the 403 above was the permission, not the agent or the space.
      await patch(role.id, { permissions: ["agents:read", "agents:run"] });
      // Past the guard and into the handler, which stops on the fixture having
      // no published version — a refusal about the agent, not about the caller.
      await expectProblem(await runAgent(asGuest), 404, { code: "no_published_version" });
    });

    it("through an invitation's space_assignments", async () => {
      const role = await createRole({ key: "invited", permissions: ["agents:read"] });

      const invited = await invite(role.id);
      expect(invited.status).toBe(201);
      expect((await invited.json()) as { space_assignments: unknown[] }).toMatchObject({
        space_assignments: [{ space_id: owner.defaultSpaceId, custom_role_id: role.id }],
      });

      // The control: a bundle belonging to ANOTHER org is refused, so the
      // acceptance above is the org check passing, not the field being ignored.
      const other = await createTestContext({ orgSlug: "roles-invite-foreign" });
      const foreign = await seedSpaceRole({ orgId: other.orgId, key: "foreign" });
      expect((await expectProblem(await invite(foreign.id), 404)).detail).toContain(foreign.id);
    });
  });
});
