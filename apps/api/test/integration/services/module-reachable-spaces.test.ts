// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import type { Context } from "hono";
import { db } from "@appstrate/db/client";
import { ensurePersonalSpace } from "@appstrate/db/provision-org";
import { buildModuleInitContext } from "../../../src/lib/modules/registry.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedSpace } from "../../helpers/seed.ts";

/**
 * `services.reachableSpaces` tells a module which reached space is the organization's default
 * and which is the caller's own personal space: the chat defaults a request naming no space to
 * the latter, else the former.
 */
describe("PlatformServices.reachableSpaces", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "reach-org" });
  });

  /** The request context the platform pipeline leaves for an org member's own session. */
  function requestOf(vars: Record<string, unknown> = {}): Context {
    const store = new Map<string, unknown>([
      ["user", ctx.user],
      ["principalKind", "user"],
      ["orgId", ctx.orgId],
      ["orgRole", "owner"],
      ["orgPermissions", new Set<string>()],
      ...Object.entries(vars),
    ]);
    return {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => store.set(key, value),
      env: undefined,
    } as unknown as Context;
  }

  it("flags the default space and the caller's own personal space", async () => {
    const personal = await db.transaction((tx) => ensurePersonalSpace(tx, ctx.orgId, ctx.user.id));
    const team = await seedSpace({ orgId: ctx.orgId, name: "Team" });
    const { services } = buildModuleInitContext();
    const { spaces } = await services.reachableSpaces(requestOf(), ctx.orgId);
    const flags = new Map(spaces.map((space) => [space.id, [space.isDefault, space.personal]]));
    expect(flags.get(ctx.defaultSpaceId)).toEqual([true, false]);
    expect(flags.get(personal!.id)).toEqual([false, true]);
    expect(flags.get(team.id)).toEqual([false, false]);
  });

  it("an unconfined caller is not confined, and each space's set is an array", async () => {
    const { services } = buildModuleInitContext();
    const reached = await services.reachableSpaces(requestOf(), ctx.orgId);
    expect(reached.confined).toBe(false);
    expect(reached.spaces.every((space) => Array.isArray(space.permissions))).toBe(true);
  });

  it("a credential confined to an allowlist reaches it alone, says so, and names its org half", async () => {
    const team = await seedSpace({ orgId: ctx.orgId, name: "Team" });
    const { services } = buildModuleInitContext();
    const reached = await services.reachableSpaces(
      requestOf({
        credentialSpaceIds: [team.id],
        orgPermissions: new Set(["org:read", "spaces:read"]),
      }),
      ctx.orgId,
    );
    expect(reached.confined).toBe(true);
    expect(reached.spaces.map((space) => space.id)).toEqual([team.id]);
    expect([...reached.orgPermissions].sort()).toEqual(["org:read", "spaces:read"]);
  });
});
