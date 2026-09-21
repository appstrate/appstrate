// SPDX-License-Identifier: Apache-2.0

/**
 * A gate reads the kind a credential DECLARES, never its transport.
 *
 * Issue #1456: the kind was inferred from `authMethod`/`deferOrgResolution`, so
 * the chat module's server-minted loopback — the same person, another carrier —
 * was neither, and a chat turn in a personal space 404'd.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setPrincipalPermissionsProviders } from "@appstrate/core/principal-permissions";
import type { AppstrateModule } from "@appstrate/core/module";
import { getTestApp } from "../../helpers/app.ts";
import { getDiscoveredModules } from "../../helpers/test-modules.ts";
import { truncateAll } from "../../helpers/db.ts";
import { expectProblem } from "../../helpers/assertions.ts";
import {
  addOrgMember,
  authHeaders,
  createTestContext,
  memberContext,
  orgOnlyHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedApiKey, seedPackage, seedSpace, seedSpaceMember } from "../../helpers/seed.ts";
import { ensurePersonalSpaceFor } from "../../../src/services/spaces.ts";
// The minting secret is process-local to that file: importing it by path gets
// the instance whose strategy the running app verifies against.
import { mintMcpLoopbackToken } from "../../../../../packages/module-chat/src/loopback-auth.ts";

/** Org-level, and absent from a `member`'s role set — see `lib/permissions.ts`. */
const GRANT = "model-provider-credentials:read";

/** `orgId:userId` → what the stub resolver answers. Rewritten per test. */
const answers = new Map<string, string[]>();

const grantModule: AppstrateModule = {
  manifest: { id: "stub-kind-grants", name: "Stub Kind Grants", version: "1.0.0" },
  async init() {},
  principalPermissions: {
    mayGrant: [GRANT],
    async resolve({ orgId, userId }) {
      return answers.get(`${orgId}:${userId}`) ?? [];
    },
  },
};

const app = getTestApp({ modules: [...getDiscoveredModules(), grantModule] });

// The registration above is global; hand it back so no other file inherits it.
afterAll(() => setPrincipalPermissionsProviders(null));

/** What `chat-stream.ts` forwards: the caller's own already-resolved set. */
const CHAT_SCOPE = ["spaces:read", "agents:read", "skills:read"] as const;

function loopbackHeaders(
  ctx: TestContext,
  opts: { orgRole: string; spaceId?: string; permissions?: readonly string[] },
): Record<string, string> {
  const token = mintMcpLoopbackToken({
    userId: ctx.user.id,
    email: ctx.user.email,
    name: ctx.user.name,
    orgId: ctx.orgId,
    orgRole: opts.orgRole,
    permissions: [...(opts.permissions ?? CHAT_SCOPE)],
  });
  return {
    Authorization: `Bearer ${token}`,
    "X-Org-Id": ctx.orgId,
    ...(opts.spaceId ? { "X-Space-Id": opts.spaceId } : {}),
  };
}

const agentsViaLoopback = (ctx: TestContext, orgRole: string, spaceId: string) =>
  app.request("/api/agents", { headers: loopbackHeaders(ctx, { orgRole, spaceId }) });

async function listSpaceIds(headers: Record<string, string>): Promise<string[]> {
  const res = await app.request("/api/spaces", { headers });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { data: Array<{ id: string }> }).data.map((s) => s.id);
}

const spacesVia = (ctx: TestContext, orgRole: string) =>
  listSpaceIds(loopbackHeaders(ctx, { orgRole }));

describe("a chat loopback bearer is the person, wherever a gate asks", () => {
  let owner: TestContext;
  let admin: TestContext;
  let member: TestContext;
  /** No row in the closed team space below. */
  let stranger: TestContext;
  let personalId: string;
  let teamId: string;

  beforeEach(async () => {
    await truncateAll();
    answers.clear();
    owner = await createTestContext({ orgSlug: "kind-org" });
    admin = await memberContext(owner, "admin");
    member = await memberContext(owner, "member");
    stranger = await memberContext(owner, "member");
    personalId = (await ensurePersonalSpaceFor(owner.orgId, member.user.id)).id;
    await ensurePersonalSpaceFor(owner.orgId, admin.user.id);
    const team = await seedSpace({ orgId: owner.orgId, name: "Team", visibility: "closed" });
    teamId = team.id;
    await seedSpaceMember({ spaceId: teamId, userId: member.user.id, presetRole: "operator" });
  });

  it("serves the member's own chat turn inside it, and refuses an admin's", async () => {
    // Before #1456 this 404'd: `callerPersonalOwnerId` answered `null` for it.
    const mine = await agentsViaLoopback(member, "member", personalId);
    expect(mine.status, await mine.clone().text()).toBe(200);

    // §3.6: an org `admin` holds `admin` in every TEAM space, and still none here.
    await expectProblem(await agentsViaLoopback(admin, "admin", personalId), 404);
  });

  it("carries the same bearer into a closed team space the member joined", async () => {
    const joined = await agentsViaLoopback(member, "member", teamId);
    expect(joined.status, await joined.clone().text()).toBe(200);

    // No row, no reach: the 200 above is the membership the hop carried.
    expect((await agentsViaLoopback(stranger, "member", teamId)).status).toBe(403);
  });

  it("lists the member's own personal space under their loopback bearer", async () => {
    // The API-key half: `personal-spaces.test.ts`, "unreachable by an API key".
    expect(await spacesVia(member, "member")).toContain(personalId);
    // The session control, then the negative: nobody else's shows up.
    expect(await listSpaceIds(orgOnlyHeaders(member))).toContain(personalId);
    expect(await spacesVia(admin, "admin")).not.toContain(personalId);
  });

  describe("per-principal grants travel with the person", () => {
    async function advertisedPermissions(headers: Record<string, string>): Promise<string[]> {
      const res = await app.request("/api/orgs", { headers });
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as { data: Array<{ permissions: string[] }> };
      return body.data[0]!.permissions;
    }

    it("reaches the loopback when its ceiling claims the string, and stops there", async () => {
      answers.set(`${owner.orgId}:${member.user.id}`, [GRANT]);

      expect(await advertisedPermissions(orgOnlyHeaders(member))).toContain(GRANT);
      // #1456's sibling: `principalGrants` answered EMPTY for the loopback.
      const claimed = loopbackHeaders(member, {
        orgRole: "member",
        permissions: [...CHAT_SCOPE, GRANT],
      });
      expect(await advertisedPermissions(claimed)).toContain(GRANT);

      // The ceiling still binds; `spaces:read` proves the list is not empty.
      const unclaimedHeaders = loopbackHeaders(member, { orgRole: "member" });
      const unclaimed = await advertisedPermissions(unclaimedHeaders);
      expect(unclaimed).not.toContain(GRANT);
      expect(unclaimed).toContain("spaces:read");

      // Advertising is not enforcing: above is `listedOrgIdentityForCaller`,
      // below is the `permissions` set the pipeline wrote, and both must agree.
      // `/registry` is org-only and reads the in-memory registry, so only the
      // permission moves its status.
      const guarded = (headers: Record<string, string>) =>
        app.request("/api/model-provider-credentials/registry", { headers });

      expect((await guarded(orgOnlyHeaders(member))).status).toBe(200);
      const enforced = await guarded(claimed);
      expect(enforced.status, await enforced.clone().text()).toBe(200);
      await expectProblem(await guarded(unclaimedHeaders), 403);
    });

    // A delegate never takes them: `middleware/principal-permissions.test.ts`.
  });
});

describe("a cross-organization fork reads the kind", () => {
  const AGENT = "@forksource/reachable";
  /** Clears `requireAnyPackageWrite` and the post-gate `agents:write` check. */
  const FORK_SCOPE = ["agents:read", "agents:write", "spaces:read"] as const;
  let home: TestContext;
  let source: TestContext;

  beforeEach(async () => {
    await truncateAll();
    home = await createTestContext({ orgSlug: "forkhome" });
    source = await createTestContext({ orgSlug: "forksource" });
    await addOrgMember(source.orgId, home.user.id, "member");
    await seedPackage({ id: AGENT, orgId: source.orgId, type: "agent" });
  });

  const fork = (headers: Record<string, string>) =>
    app.request("/api/packages/%40forksource/reachable/fork", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

  it("lets a loopback invoke the person's foreign standing, and refuses a key", async () => {
    // On `main` this first call 404'd exactly like the key below. Past the gate
    // the fork fails on the missing published version — a different refusal.
    const loopback = loopbackHeaders(home, {
      orgRole: "owner",
      spaceId: home.defaultSpaceId,
      permissions: FORK_SCOPE,
    });
    await expectProblem(await fork(loopback), 400, { code: "invalid_request" });
    // The reference the rule was written for.
    await expectProblem(await fork(authHeaders(home)), 400, { code: "invalid_request" });

    const key = await seedApiKey({
      orgId: home.orgId,
      spaceId: home.defaultSpaceId,
      createdBy: home.user.id,
      scopes: [...FORK_SCOPE],
    });
    // A delegate carries the creator's authority HERE, never their standing there.
    await expectProblem(await fork({ Authorization: `Bearer ${key.rawKey}` }), 404, {
      code: "not_found",
    });
  });
});
