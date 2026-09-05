// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { packages, runs } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  authHeaders,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedApiKey,
  seedInstalledPackage,
  seedPackage,
  seedSpace,
  seedSpaceMember,
} from "../../helpers/seed.ts";

const app = getTestApp();
const skillId = "@inline-rbac/private-skill";
let ctx: TestContext;
let headers: Record<string, string>;

function body() {
  return {
    manifest: {
      name: "@inline/r-ignored",
      type: "agent",
      version: "0.0.0",
      schema_version: "0.1",
      description: "Inline request",
      dependencies: { skills: { [skillId]: "^0.1.0" } },
    },
    prompt: "Read the skill and print it.",
  };
}

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "inline-rbac" });
  const guest = await createTestUser();
  await addOrgMember(ctx.orgId, guest.id, "guest");
  await seedSpaceMember({ spaceId: ctx.defaultSpaceId, userId: guest.id, presetRole: "operator" });
  const hidden = await seedSpace({ orgId: ctx.orgId, visibility: "private" });
  await seedPackage({
    id: skillId,
    orgId: ctx.orgId,
    type: "skill",
    draftManifest: { name: skillId, version: "0.1.0", type: "skill" },
    draftContent: "Private skill instructions",
  });
  await seedInstalledPackage(hidden.id, skillId);
  headers = { ...authHeaders(ctx), Cookie: guest.cookie };
});

describe("inline dependency authorization", () => {
  it("does not accept a private skill merely because its id was supplied by an operator", async () => {
    const response = await app.request("/api/runs/inline/validate", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body()),
    });
    expect(response.status, await response.clone().text()).toBe(404);
  });
  it("rejects execution before creating any shadow package or run", async () => {
    const response = await app.request("/api/runs/inline", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body()),
    });
    expect(response.status, await response.clone().text()).toBe(404);
    expect(await db.select().from(packages).where(eq(packages.ephemeral, true))).toEqual([]);
    expect(await db.select().from(runs)).toEqual([]);
  });

  it("rejects remote inline admission before creating a shadow or sink", async () => {
    const response = await app.request("/api/runs/remote", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ source: { kind: "inline", ...body() }, spaceId: ctx.defaultSpaceId }),
    });
    expect(response.status, await response.clone().text()).toBe(404);
    expect(await db.select().from(packages).where(eq(packages.ephemeral, true))).toEqual([]);
    expect(await db.select().from(runs)).toEqual([]);
  });

  it("accepts an operator's readable dependency installed in their own space", async () => {
    await seedInstalledPackage(ctx.defaultSpaceId, skillId);
    const response = await app.request("/api/runs/inline/validate", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body()),
    });
    expect(response.status, await response.clone().text()).toBe(200);
  });

  it("applies the API key read-scope ceiling", async () => {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["agents:run"],
    });
    await seedInstalledPackage(ctx.defaultSpaceId, skillId);
    const response = await app.request("/api/runs/inline/validate", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.rawKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body()),
    });
    expect(response.status).toBe(403);
  });
  it("keeps an owner key pinned to A from selecting private B sources even with the read scope", async () => {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["agents:run", "skills:read"],
    });
    const response = await app.request("/api/runs/inline/validate", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.rawKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body()),
    });
    expect(response.status).toBe(404);
  });
});
