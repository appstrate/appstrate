// SPDX-License-Identifier: Apache-2.0

/**
 * A gate reads the principal a credential DECLARES, never its transport.
 *
 * Issue #1456: the platform inferred "is this credential the human?" from
 * `authMethod === "session" || deferOrgResolution`, so the chat module's
 * server-minted loopback — the same person, another carrier — was neither, and
 * a chat turn in a personal space 404'd. Every test below pairs that loopback
 * with a credential differing ONLY in its declared kind.
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
// Reaching into the chat module's source on purpose: the minting secret is
// process-local to that file, so importing it by path gets the SAME module
// instance whose strategy the running app verifies against.
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

/** A space-scoped read, as the chat module's own bearer would make it. */
const agentsVia = (ctx: TestContext, orgRole: string, spaceId: string) =>
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
  /** A second plain member, in no space of their own beyond the personal one. */
  let other: TestContext;
  let personalId: string;
  let teamId: string;

  beforeEach(async () => {
    await truncateAll();
    answers.clear();
    owner = await createTestContext({ orgSlug: "kind-org" });
    admin = await memberContext(owner, "admin");
    member = await memberContext(owner, "member");
    other = await memberContext(owner, "member");
    personalId = (await ensurePersonalSpaceFor(owner.orgId, member.user.id)).id;
    await ensurePersonalSpaceFor(owner.orgId, admin.user.id);
    const team = await seedSpace({ orgId: owner.orgId, name: "Team", visibility: "closed" });
    teamId = team.id;
    await seedSpaceMember({ spaceId: teamId, userId: member.user.id, presetRole: "operator" });
  });

  it("serves the member's own chat turn inside it, and refuses an admin's", async () => {
    // Before #1456 this first call 404'd: the loopback was neither a session
    // nor a deferring strategy, so `callerPersonalOwnerId` answered `null`.
    const mine = await agentsVia(member, "member", personalId);
    expect(mine.status, await mine.clone().text()).toBe(200);

    // Nobody else reaches one (RBAC spec §3.6) — and an org `admin` is the
    // caller who holds `admin` in every TEAM space, so this is the control that
    // would fail if the fix had widened the gate instead of declaring the kind.
    await expectProblem(await agentsVia(admin, "admin", personalId), 404);
  });

  it("carries the same bearer into a closed team space the member joined", async () => {
    const joined = await agentsVia(member, "member", teamId);
    expect(joined.status, await joined.clone().text()).toBe(200);

    // A closed space reaches nobody without a row, so the 200 above is the
    // membership the hop carried and not the org role that came with it.
    expect((await agentsVia(other, "member", teamId)).status).toBe(403);
  });

  it("lists the member's own personal space under their loopback bearer", async () => {
    // The API-key half of this listing is pinned in `routes/personal-spaces.test.ts`
    // ("is unreachable by an API key, whoever created it").
    expect(await spacesVia(member, "member")).toContain(personalId);
    // The session control: the same person, the credential the rule was written
    // for, answers the same list.
    expect(await listSpaceIds(orgOnlyHeaders(member))).toContain(personalId);
    // And nobody else's: the admin's bearer sees their own, never the member's.
    expect(await spacesVia(admin, "admin")).not.toContain(personalId);
  });

  describe("per-principal grants travel with the person", () => {
    /** The org half as `GET /api/orgs` reports it, ceiling applied. */
    async function listedPermissions(headers: Record<string, string>): Promise<string[]> {
      const res = await app.request("/api/orgs", { headers });
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as { data: Array<{ permissions: string[] }> };
      return body.data[0]!.permissions;
    }

    it("reaches the loopback when its ceiling claims the string, and stops there", async () => {
      answers.set(`${owner.orgId}:${member.user.id}`, [GRANT]);

      expect(await listedPermissions(orgOnlyHeaders(member))).toContain(GRANT);
      // The #1456 sibling defect: the loopback was not the person, so
      // `principalGrants` answered EMPTY and the turn lost every grant.
      const claimed = loopbackHeaders(member, {
        orgRole: "member",
        permissions: [...CHAT_SCOPE, GRANT],
      });
      expect(await listedPermissions(claimed)).toContain(GRANT);

      // The ceiling still binds: same principal, same grant, a token that never
      // claimed it. `spaces:read` is the control that the list is not empty.
      const unclaimed = await listedPermissions(loopbackHeaders(member, { orgRole: "member" }));
      expect(unclaimed).not.toContain(GRANT);
      expect(unclaimed).toContain("spaces:read");
    });

    // A delegate never takes them, and the module is never even asked:
    // `middleware/principal-permissions.test.ts` pins that on the call counter.
  });
});

describe("a cross-organization fork reads the kind", () => {
  const AGENT = "@forksource/reachable";
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

  it("lets the user invoke their foreign membership and refuses their own key", async () => {
    // `cross-org-package-reach.test.ts` pins which ROLE answers over there; the
    // kind gate in front of it is what these two calls separate.
    //
    // Past the gate the fork fails on the source's missing published version —
    // a different refusal, which is what proves it got through.
    await expectProblem(await fork(authHeaders(home)), 400, { code: "invalid_request" });

    const key = await seedApiKey({
      orgId: home.orgId,
      spaceId: home.defaultSpaceId,
      createdBy: home.user.id,
      scopes: ["agents:write", "agents:read"],
    });
    // Same person behind it, same membership over there: a delegate carries
    // their authority in THIS org, never their standing in another.
    await expectProblem(await fork({ Authorization: `Bearer ${key.rawKey}` }), 404, {
      code: "not_found",
    });
  });
});
