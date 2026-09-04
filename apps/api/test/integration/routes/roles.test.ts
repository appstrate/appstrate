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
import {
  addOrgMember,
  authHeaders,
  createTestContext,
  createTestUser,
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
}

interface Problem {
  code: string;
  detail: string;
  param?: string;
  member_count?: number;
  pending_invitation_count?: number;
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

  const post = (body: unknown, ctx: TestContext = owner) =>
    app.request("/api/roles", {
      method: "POST",
      headers: { ...orgOnlyHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const validBody = (over: Record<string, unknown> = {}) => ({
    key: "support",
    name: "Support",
    permissions: ["agents:read", "runs:read"],
    ...over,
  });

  describe("GET /api/roles", () => {
    it("lists the four presets with their permissions, then the org's own bundles", async () => {
      const custom = await seedSpaceRole({ orgId: owner.orgId, key: "support", name: "Support" });
      const res = await app.request("/api/roles", { headers: orgOnlyHeaders(owner) });
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: RoleWire[] };

      expect(data.filter((r) => r.kind === "preset").map((r) => r.key)).toEqual([
        "admin",
        "builder",
        "operator",
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

    it("does not list another org's bundles", async () => {
      const other = await createTestContext({ orgSlug: "roles-other" });
      await seedSpaceRole({ orgId: other.orgId, key: "foreign" });
      const res = await app.request("/api/roles", { headers: orgOnlyHeaders(owner) });
      const { data } = (await res.json()) as { data: RoleWire[] };
      expect(data.filter((r) => r.kind === "custom")).toEqual([]);
    });

    it("an org member reads the catalog but cannot define a bundle", async () => {
      // A space `admin` is often only an org `member`; assigning a role means
      // seeing what is assignable. Defining one stays owner/admin.
      const user = await createTestUser();
      await addOrgMember(owner.orgId, user.id, "member");
      const asMember: TestContext = { ...owner, user, cookie: user.cookie };

      expect((await app.request("/api/roles", { headers: orgOnlyHeaders(asMember) })).status).toBe(
        200,
      );
      expect(
        (await app.request("/api/roles/vocabulary", { headers: orgOnlyHeaders(asMember) })).status,
      ).toBe(200);
      expect((await post(validBody(), asMember)).status).toBe(403);
    });

    it("a guest reads nothing — roles are the org's own vocabulary", async () => {
      const user = await createTestUser();
      await addOrgMember(owner.orgId, user.id, "guest");
      const asGuest: TestContext = { ...owner, user, cookie: user.cookie };
      expect((await app.request("/api/roles", { headers: orgOnlyHeaders(asGuest) })).status).toBe(
        403,
      );
      expect(
        (await app.request("/api/roles/vocabulary", { headers: orgOnlyHeaders(asGuest) })).status,
      ).toBe(403);
      // The control: the same two requests from the owner.
      expect((await app.request("/api/roles", { headers: orgOnlyHeaders(owner) })).status).toBe(
        200,
      );
      expect(
        (await app.request("/api/roles/vocabulary", { headers: orgOnlyHeaders(owner) })).status,
      ).toBe(200);
    });
  });

  describe("GET /api/roles/vocabulary", () => {
    it("offers exactly what the validator accepts, grouped by resource", async () => {
      const res = await app.request("/api/roles/vocabulary", { headers: orgOnlyHeaders(owner) });
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
      // Space-level only: an org-level string must not be offerable.
      expect(flat.map((p) => p.permission)).toContain("agents:write");
      expect(flat.map((p) => p.permission)).not.toContain("members:invite");
      expect(flat.map((p) => p.permission)).not.toContain("roles:write");

      // Grantability is the API-key allowlist, not a second hand-kept table:
      // `integrations:configure` is deliberately session-only.
      const byName = new Map(flat.map((p) => [p.permission, p]));
      expect(byName.get("agents:run")!.api_key_grantable).toBe(true);
      expect(byName.get("integrations:configure")!.api_key_grantable).toBe(false);
      expect(byName.get("agents:read")!.action).toBe("read");

      // And every offered string is accepted by the create route.
      const created = await post(validBody({ permissions: flat.map((p) => p.permission) }));
      expect(created.status).toBe(201);
    });
  });

  describe("POST /api/roles validation", () => {
    it("refuses an unknown permission, naming it, and accepts the known twin", async () => {
      const bad = await post(validBody({ permissions: ["agents:read", "agents:teleport"] }));
      expect(bad.status).toBe(400);
      const problem = (await bad.json()) as Problem;
      expect(problem.detail).toContain("agents:teleport");
      expect(problem.param).toBe("permissions");

      expect((await post(validBody())).status).toBe(201);
    });

    it("refuses an ORG-level permission — a space role can only hold space strings", async () => {
      const res = await post(validBody({ permissions: ["members:invite"] }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as Problem).detail).toContain("members:invite");
    });

    it("refuses an empty permission list", async () => {
      const res = await post(validBody({ permissions: [] }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as Problem).param).toBe("permissions");
    });

    it("refuses a preset key and accepts a free one", async () => {
      const res = await post(validBody({ key: "builder" }));
      expect(res.status).toBe(400);
      const problem = (await res.json()) as Problem;
      expect(problem.param).toBe("key");
      expect(problem.detail).toContain("builder");

      expect((await post(validBody({ key: "builders" }))).status).toBe(201);
    });

    it("refuses a key that is not a slug", async () => {
      expect((await post(validBody({ key: "Support Team" }))).status).toBe(400);
    });

    it("409 role_key_taken on a collision within the org, but not across orgs", async () => {
      expect((await post(validBody())).status).toBe(201);
      const dup = await post(validBody({ name: "Support 2" }));
      expect(dup.status).toBe(409);
      expect(((await dup.json()) as Problem).code).toBe("role_key_taken");

      const other = await createTestContext({ orgSlug: "roles-sibling" });
      expect((await post(validBody(), other)).status).toBe(201);
    });
  });

  describe("PATCH / DELETE scoping", () => {
    it("another org's role is a 404 on PATCH and on DELETE", async () => {
      const other = await createTestContext({ orgSlug: "roles-foreign" });
      const foreign = await seedSpaceRole({ orgId: other.orgId, key: "foreign" });

      const patched = await app.request(`/api/roles/${foreign.id}`, {
        method: "PATCH",
        headers: { ...orgOnlyHeaders(owner), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Stolen" }),
      });
      expect(patched.status).toBe(404);
      expect(
        (
          await app.request(`/api/roles/${foreign.id}`, {
            method: "DELETE",
            headers: orgOnlyHeaders(owner),
          })
        ).status,
      ).toBe(404);

      // The control: its own org reaches it.
      expect(
        (
          await app.request(`/api/roles/${foreign.id}`, {
            method: "DELETE",
            headers: orgOnlyHeaders(other),
          })
        ).status,
      ).toBe(204);
    });

    it("a malformed role id is a 400 naming the field, not a 404", async () => {
      const res = await app.request("/api/roles/rol_nope", {
        method: "DELETE",
        headers: orgOnlyHeaders(owner),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as Problem).param).toBe("id");
    });

    it("PATCH re-scopes the bundle and validates the new permissions", async () => {
      const role = await seedSpaceRole({ orgId: owner.orgId, key: "support" });
      const bad = await app.request(`/api/roles/${role.id}`, {
        method: "PATCH",
        headers: { ...orgOnlyHeaders(owner), "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: ["agents:teleport"] }),
      });
      expect(bad.status).toBe(400);

      const ok = await app.request(`/api/roles/${role.id}`, {
        method: "PATCH",
        headers: { ...orgOnlyHeaders(owner), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Support", permissions: ["agents:read", "agents:run"] }),
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

      const refused = await app.request(`/api/roles/${held.id}`, {
        method: "DELETE",
        headers: orgOnlyHeaders(owner),
      });
      expect(refused.status).toBe(409);
      const problem = (await refused.json()) as Problem;
      expect(problem.code).toBe("role_in_use");
      expect(problem.member_count).toBe(1);
      expect(problem.pending_invitation_count).toBe(0);

      expect(
        (
          await app.request(`/api/roles/${free.id}`, {
            method: "DELETE",
            headers: orgOnlyHeaders(owner),
          })
        ).status,
      ).toBe(204);
    });

    it("409s on a PENDING invitation that assigns it, with zero members", async () => {
      // The assignments are JSONB, so no FK holds this one — without the count
      // the role would vanish and the invitee would accept into nothing.
      const created = await post(validBody({ key: "promised" }));
      const role = (await created.json()) as RoleWire;
      const invited = await app.request(`/api/orgs/${owner.orgId}/members`, {
        method: "POST",
        headers: { ...orgOnlyHeaders(owner), "Content-Type": "application/json" },
        body: JSON.stringify({
          email: `promised-${crypto.randomUUID().slice(0, 8)}@test.com`,
          role: "guest",
          space_assignments: [{ space_id: owner.defaultSpaceId, custom_role_id: role.id }],
        }),
      });
      expect(invited.status).toBe(201);

      const refused = await app.request(`/api/roles/${role.id}`, {
        method: "DELETE",
        headers: orgOnlyHeaders(owner),
      });
      expect(refused.status).toBe(409);
      const problem = (await refused.json()) as Problem;
      expect(problem.code).toBe("role_in_use");
      expect(problem.member_count).toBe(0);
      expect(problem.pending_invitation_count).toBe(1);

      // The control: an invitation naming ANOTHER role does not hold this one.
      const free = await post(validBody({ key: "unpromised" }));
      const other = (await free.json()) as RoleWire;
      expect(
        (
          await app.request(`/api/roles/${other.id}`, {
            method: "DELETE",
            headers: orgOnlyHeaders(owner),
          })
        ).status,
      ).toBe(204);
    });
  });

  describe("features.custom_roles gate", () => {
    it("the three write routes 403 without the flag and succeed with it", async () => {
      const role = await seedSpaceRole({ orgId: owner.orgId, key: "support" });
      restoreFlag();
      restoreFlag = setFeatureFlag("custom_roles", false);

      const created = await post(validBody({ key: "gated" }));
      expect(created.status).toBe(403);
      expect(((await created.json()) as Problem).code).toBe("feature_unavailable");

      const patched = await app.request(`/api/roles/${role.id}`, {
        method: "PATCH",
        headers: { ...orgOnlyHeaders(owner), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Nope" }),
      });
      expect(patched.status).toBe(403);

      const deleted = await app.request(`/api/roles/${role.id}`, {
        method: "DELETE",
        headers: orgOnlyHeaders(owner),
      });
      expect(deleted.status).toBe(403);

      // Reading never depends on the flag — the presets and the existing
      // bundles stay visible in OSS.
      expect((await app.request("/api/roles", { headers: orgOnlyHeaders(owner) })).status).toBe(
        200,
      );
      expect(
        (await app.request("/api/roles/vocabulary", { headers: orgOnlyHeaders(owner) })).status,
      ).toBe(200);

      // The control: the same three calls with the flag back on.
      restoreFlag();
      restoreFlag = setFeatureFlag("custom_roles", true);
      expect((await post(validBody({ key: "gated" }))).status).toBe(201);
      expect(
        (
          await app.request(`/api/roles/${role.id}`, {
            method: "PATCH",
            headers: { ...orgOnlyHeaders(owner), "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Yes" }),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await app.request(`/api/roles/${role.id}`, {
            method: "DELETE",
            headers: orgOnlyHeaders(owner),
          })
        ).status,
      ).toBe(204);
    });
  });

  describe("a custom role is assignable and grants exactly its permissions", () => {
    beforeEach(async () => {
      await seedPackage({ orgId: owner.orgId, id: "@roles/agent", type: "agent" });
      await seedInstalledPackage(owner.defaultSpaceId, "@roles/agent");
    });

    it("through POST /api/spaces/:id/members, a read-only bundle reads but cannot run", async () => {
      const created = await post(validBody({ key: "reader", permissions: ["agents:read"] }));
      expect(created.status).toBe(201);
      const role = (await created.json()) as RoleWire;

      const user = await createTestUser();
      await addOrgMember(owner.orgId, user.id, "guest");
      const assigned = await app.request(`/api/spaces/${owner.defaultSpaceId}/members`, {
        method: "POST",
        headers: { ...orgOnlyHeaders(owner), "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, custom_role_id: role.id }),
      });
      expect(assigned.status).toBe(201);

      const asGuest: TestContext = { ...owner, user, cookie: user.cookie };
      expect((await app.request("/api/agents", { headers: authHeaders(asGuest) })).status).toBe(
        200,
      );

      const ran = await app.request("/api/agents/@roles/agent/run", {
        method: "POST",
        headers: { ...authHeaders(asGuest), "Content-Type": "application/json" },
        body: JSON.stringify({ input: {} }),
      });
      expect(ran.status).toBe(403);
      expect(((await ran.json()) as Problem).detail).toContain("agents:run");

      // The control: the same bundle plus `agents:run` clears that guard —
      // so the 403 above was the permission, not the agent or the space.
      await app.request(`/api/roles/${role.id}`, {
        method: "PATCH",
        headers: { ...orgOnlyHeaders(owner), "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: ["agents:read", "agents:run"] }),
      });
      const rerun = await app.request("/api/agents/@roles/agent/run", {
        method: "POST",
        headers: { ...authHeaders(asGuest), "Content-Type": "application/json" },
        body: JSON.stringify({ input: {} }),
      });
      expect(rerun.status).not.toBe(403);
    });

    it("through an invitation's space_assignments", async () => {
      const created = await post(validBody({ key: "invited", permissions: ["agents:read"] }));
      const role = (await created.json()) as RoleWire;

      const invite = (customRoleId: string) =>
        app.request(`/api/orgs/${owner.orgId}/members`, {
          method: "POST",
          headers: { ...orgOnlyHeaders(owner), "Content-Type": "application/json" },
          body: JSON.stringify({
            email: `invitee-${crypto.randomUUID().slice(0, 8)}@test.com`,
            role: "guest",
            space_assignments: [{ space_id: owner.defaultSpaceId, custom_role_id: customRoleId }],
          }),
        });

      const invited = await invite(role.id!);
      expect(invited.status).toBe(201);
      expect((await invited.json()) as { space_assignments: unknown[] }).toMatchObject({
        space_assignments: [{ space_id: owner.defaultSpaceId, custom_role_id: role.id }],
      });

      // The control: a bundle belonging to ANOTHER org is refused, so the
      // acceptance above is the org check passing, not the field being ignored.
      const other = await createTestContext({ orgSlug: "roles-invite-foreign" });
      const foreign = await seedSpaceRole({ orgId: other.orgId, key: "foreign" });
      expect((await invite(foreign.id)).status).not.toBe(201);
    });
  });
});
