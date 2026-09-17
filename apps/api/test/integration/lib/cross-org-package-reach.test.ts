// SPDX-License-Identifier: Apache-2.0

/**
 * A read that crosses into ANOTHER organization is answered by the caller's
 * standing THERE (RBAC spec §6.9).
 *
 * `packageAccessSpaces` and `assertCatalogPackageAccess` both default their org
 * to the one the request is scoped to. A fork is the one read that crosses, and
 * it has to name the other organization — at which point the role becomes the
 * load-bearing half: `callerOrgRole` falls back to `c.get("orgRole")` when an
 * org carries no persona, so a foreign org resolved WITHOUT a role would grant
 * the caller their CURRENT standing over somebody else's spaces. An `owner`
 * here would read a `private` space there, and nothing would say so.
 *
 * `ForeignOrgStanding` carries the two halves together so that mistake has
 * nowhere to live. This suite is what keeps the rule honest anyway, because the
 * type alone cannot tell a WRONG role from a right one: the same package, the
 * same caller and the same stub context are asked twice, differing only in the
 * role inside the standing, and they must answer differently. A role that was
 * being ignored in favour of the current org's would make both calls agree.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Context } from "hono";
import { ApiError } from "@appstrate/core/api-errors";
import {
  assertCatalogPackageAccess,
  packageAccessSpaces,
} from "../../../src/lib/package-access.ts";
import type { AppEnv } from "../../../src/types/index.ts";
import { truncateAll } from "../../helpers/db.ts";
import { getTestApp } from "../../helpers/app.ts";
import {
  addOrgMember,
  authHeaders,
  createTestContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedPackage, seedSpace } from "../../helpers/seed.ts";

const app = getTestApp();

const AGENT = "@crossorg/hidden-agent";

let home: TestContext;
/** The organization the package lives in — the caller is a plain member of it. */
let source: TestContext;
/** A `private` space of the SOURCE org, homing the package. Nobody is a member. */
let hiddenSpaceId: string;

/**
 * The caller: an `owner` of their OWN organization, with a real user id so the
 * membership reads resolve. Nothing seeds the memo — the point of the suite is
 * the resolve itself.
 */
function caller(): Context<AppEnv> {
  const values: Record<string, unknown> = {
    orgId: home.orgId,
    orgRole: "owner",
    authMethod: "session",
    user: { id: home.user.id },
    permissions: new Set(["agents:read"]),
  };
  return {
    get: (key: string) => values[key],
    set: (key: string, value: unknown) => {
      values[key] = value;
    },
  } as unknown as Context<AppEnv>;
}

beforeEach(async () => {
  await truncateAll();
  home = await createTestContext({ orgSlug: "crossown" });
  source = await createTestContext({ orgSlug: "crossorg" });
  await addOrgMember(source.orgId, home.user.id, "member");
  hiddenSpaceId = (await seedSpace({ orgId: source.orgId, name: "Hidden", visibility: "private" }))
    .id;
  await seedPackage({
    id: AGENT,
    orgId: source.orgId,
    type: "agent",
    homeSpaceId: hiddenSpaceId,
    draftManifest: { name: AGENT, version: "0.1.0", type: "agent" },
    draftContent: "prompt",
  });
});

describe("the standing that reaches a foreign organization is the role held THERE", () => {
  it("hides a package homed in a private space of the source org from a plain member", async () => {
    const refused = await assertCatalogPackageAccess(caller(), AGENT, {
      orgId: source.orgId,
      orgRole: "member",
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(404);
  });

  it("shows the same package to the same caller when the standing says admin", async () => {
    // The POSITIVE control of the pair. Nothing about the caller changed — only
    // the role inside the standing — so this passing while the case above fails
    // is what proves the role is read rather than replaced by the current org's.
    const pkg = await assertCatalogPackageAccess(caller(), AGENT, {
      orgId: source.orgId,
      orgRole: "admin",
    });
    expect(pkg.id).toBe(AGENT);
  });

  it("resolves no space of the source org for a plain member, and every one for an admin", async () => {
    const c = caller();
    const asMember = await packageAccessSpaces(c, { orgId: source.orgId, orgRole: "member" });
    const asAdmin = await packageAccessSpaces(c, { orgId: source.orgId, orgRole: "admin" });
    // Same context, same request, two live answers: the memo is keyed on the
    // role as well as the org, so neither call can be served the other's set.
    expect(asMember.map((s) => s.id)).not.toContain(hiddenSpaceId);
    expect(asAdmin.map((s) => s.id)).toContain(hiddenSpaceId);
  });
});

describe("the fork route reads the source org under that same standing", () => {
  it("404s on a package homed in a source-org space the caller cannot reach", async () => {
    // End to end, because the chain is what a future caller would break:
    // `assertForkSourceAccess` reads the membership, and hands the standing to
    // both `packageAccessSpaces` and `assertCatalogPackageAccess`. A break
    // anywhere in it surfaces here as the fork getting PAST the gate — it then
    // answers `400 invalid_request` on the missing published version, which is
    // a different refusal and a failure of this test.
    const res = await app.request("/api/packages/%40crossorg/hidden-agent/fork", {
      method: "POST",
      headers: authHeaders(home, { "Content-Type": "application/json" }),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code?: string }).code).toBe("not_found");
  });
});
