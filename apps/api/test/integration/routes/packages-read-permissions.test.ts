// SPDX-License-Identifier: Apache-2.0

/**
 * RBAC on the package READ surface (issue #1123).
 *
 * Every `GET` under `/api/packages` used to be gated on `hasPackageAccess`
 * alone — a visibility check ("is this package a system package, or installed
 * in THIS space?"), never an authorization one. A credential scoped
 * without `skills:read` could therefore read a skill's manifest AND its full
 * `SKILL.md` through the detail route, and pull the published ZIP through
 * `/{version}/download`.
 *
 * These tests pin the guard per route rather than once: the value of the fix
 * is that the surface is coherent, so a regression on any single route (a new
 * `router.get` registered without `readGuard`) has to fail here.
 *
 * The scoped API key is the only credential that can express "authenticated
 * for this org, without `<type>:read`" — every org ROLE, down to `viewer`,
 * carries all four read scopes, which is exactly why this gap was invisible
 * from the SPA.
 *
 * The file-explorer block at the bottom covers the two routes #1118 added
 * (`/files`, `/files/content`), which were not on `main` when the fix above
 * was written. They are the sharpest case on the whole surface: the index
 * inlines text content and `/files/content` serves ANY byte of the artifact.
 * They also short-circuit to `304` from an ETag before the artifact is read,
 * so WHERE the guard sits is load-bearing, not cosmetic — see
 * "cannot be bypassed with a replayed If-None-Match".
 */

import { describe, it, expect, beforeEach, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import { spacePackages } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import {
  seedPackage,
  seedInstalledPackage,
  seedApiKey,
  seedPackageVersion,
} from "../../helpers/seed.ts";
import { zipArtifact } from "@appstrate/core/zip";
import { computeIntegrity } from "@appstrate/core/integrity";
import * as storage from "@appstrate/db/storage";
import {
  AGENT_PACKAGES_BUCKET,
  versionZipKey,
} from "../../../src/services/package-storage-keys.ts";

const app = getTestApp();

const SKILL_ID = "@testorg/read-guard-skill";
const SKILL_BODY =
  "---\nname: read-guard-skill\ndescription: A read-guard skill.\n---\n\nSECRET SKILL BODY";

/**
 * Publish a real artifact so the version routes can reach their `200`. Without
 * bytes in storage every call answers `404 Artifact not found in storage`,
 * which would make the negative assertions below pass for the wrong reason.
 */
async function publishSkill(ctx: TestContext, version = "0.1.0"): Promise<void> {
  await seedPackage({ id: SKILL_ID, type: "skill", orgId: ctx.orgId, createdBy: ctx.user.id });

  const zip = zipArtifact({
    "manifest.json": new TextEncoder().encode(
      JSON.stringify({ name: SKILL_ID, version, type: "skill" }),
    ),
    "SKILL.md": new TextEncoder().encode(SKILL_BODY),
  });
  await storage.uploadFile(AGENT_PACKAGES_BUCKET, versionZipKey(SKILL_ID, version), zip);

  await seedPackageVersion({
    packageId: SKILL_ID,
    version,
    integrity: computeIntegrity(zip),
    artifactSize: zip.byteLength,
    manifest: { name: SKILL_ID, version, type: "skill" },
  });
}

/**
 * Every GET route the packages router exposes for a single skill.
 *
 * The unscoped `/{path}/:id` variant is not listed: package ids are `@scope/name`
 * throughout, so the scoped route matches first and `:id` is unreachable for
 * anything seedable here. It carries the same `readGuard` in the same loop.
 */
function skillReadRoutes(): { label: string; path: string }[] {
  return [
    { label: "list", path: "/api/packages/skills" },
    { label: "detail", path: `/api/packages/skills/${SKILL_ID}` },
    { label: "versions", path: `/api/packages/skills/${SKILL_ID}/versions` },
    { label: "versions/info", path: `/api/packages/skills/${SKILL_ID}/versions/info` },
    { label: "version detail", path: `/api/packages/skills/${SKILL_ID}/versions/0.1.0` },
  ];
}

describe("packages GET routes — read permission", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    await truncateAll();
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });

    await seedPackage({
      id: SKILL_ID,
      type: "skill",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: {
        name: SKILL_ID,
        version: "0.1.0",
        type: "skill",
        description: "Guarded skill",
      },
      draftContent: SKILL_BODY,
    });
    await seedInstalledPackage(ctx.defaultSpaceId, SKILL_ID);
    await seedPackageVersion({
      packageId: SKILL_ID,
      version: "0.1.0",
      manifest: { name: SKILL_ID, version: "0.1.0", type: "skill" },
    });
  });

  /** Key authenticated for the org + app, but WITHOUT `skills:read`. */
  async function keyWithoutSkillsRead(): Promise<string> {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["runs:read"],
    });
    return key.rawKey;
  }

  async function keyWithSkillsRead(): Promise<string> {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["skills:read"],
    });
    return key.rawKey;
  }

  it("403s every skill GET for a key without skills:read", async () => {
    const rawKey = await keyWithoutSkillsRead();

    for (const route of skillReadRoutes()) {
      const res = await app.request(route.path, {
        headers: { Authorization: `Bearer ${rawKey}` },
      });
      expect(`${route.label}: ${res.status}`).toBe(`${route.label}: 403`);
    }
  });

  it("serves the same GETs once the key holds skills:read", async () => {
    const rawKey = await keyWithSkillsRead();

    for (const route of skillReadRoutes()) {
      const res = await app.request(route.path, {
        headers: { Authorization: `Bearer ${rawKey}` },
      });
      expect(`${route.label}: ${res.status}`).toBe(`${route.label}: 200`);
    }
  });

  it("does not leak SKILL.md through the detail route's `content`", async () => {
    // The sharpest case in #1123: `buildPackageDetailDto` spreads `getOrgItem`,
    // which carries `content` (the authored SKILL.md) and the full manifest.
    const rawKey = await keyWithoutSkillsRead();

    const res = await app.request(`/api/packages/skills/${SKILL_ID}`, {
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("SECRET SKILL BODY");
  });

  it("keeps org-role sessions unaffected (every role carries the read scopes)", async () => {
    const res = await app.request(`/api/packages/skills/${SKILL_ID}`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content?: string };
    expect(body.content).toContain("SECRET SKILL BODY");
  });

  it("applies the resource matching the package type, not a single blanket scope", async () => {
    // An `agents:read`-only key must not reach a SKILL — the per-type guard is
    // the point. Reading the agent is still allowed with the same key.
    const agentId = "@testorg/read-guard-agent";
    await seedPackage({ id: agentId, type: "agent", orgId: ctx.orgId, createdBy: ctx.user.id });
    await seedInstalledPackage(ctx.defaultSpaceId, agentId);

    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["agents:read"],
    });

    const skillRes = await app.request(`/api/packages/skills/${SKILL_ID}`, {
      headers: { Authorization: `Bearer ${key.rawKey}` },
    });
    expect(skillRes.status).toBe(403);

    const agentRes = await app.request(`/api/packages/agents/${agentId}`, {
      headers: { Authorization: `Bearer ${key.rawKey}` },
    });
    expect(agentRes.status).toBe(200);
  });
});

describe("packages version download — access + read permission", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  it("403s a download for a key without the package type's read scope", async () => {
    await publishSkill(ctx);
    await seedInstalledPackage(ctx.defaultSpaceId, SKILL_ID);

    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["runs:read"],
    });

    const res = await app.request(`/api/packages/${SKILL_ID}/0.1.0/download`, {
      headers: { Authorization: `Bearer ${key.rawKey}` },
    });
    expect(res.status).toBe(403);
  });

  it("serves the artifact to a key holding skills:read", async () => {
    await publishSkill(ctx);
    await seedInstalledPackage(ctx.defaultSpaceId, SKILL_ID);

    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["skills:read"],
    });

    const res = await app.request(`/api/packages/${SKILL_ID}/0.1.0/download`, {
      headers: { Authorization: `Bearer ${key.rawKey}` },
    });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("404s a download for a package that is not installed in the calling space", async () => {
    // Pre-fix this route resolved the row with `orgOrSystemFilter` alone and
    // never called `hasPackageAccess`, so it served artifact bytes for
    // packages the `/files` routes correctly hide. Permission is held here
    // (owner session) — the 404 is the visibility gate, nothing else.
    await publishSkill(ctx);

    const res = await app.request(`/api/packages/${SKILL_ID}/0.1.0/download`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });
});

describe("packages file explorer — read permission", () => {
  let ctx: TestContext;

  /**
   * Both file-explorer routes, in both snapshot modes. The draft and the
   * version pin take different code paths (`resolvePackageFileValidator`
   * returns `snapshotId: null` for a draft, so only the version pin can reach
   * the pre-read `304` short-circuit) and the guard has to cover both.
   */
  function explorerRoutes(): { label: string; path: string }[] {
    return [
      { label: "index draft", path: `/api/packages/${SKILL_ID}/files` },
      { label: "index version", path: `/api/packages/${SKILL_ID}/files?version=0.1.0` },
      { label: "content draft", path: `/api/packages/${SKILL_ID}/files/content?path=SKILL.md` },
      {
        label: "content version",
        path: `/api/packages/${SKILL_ID}/files/content?path=SKILL.md&version=0.1.0`,
      },
    ];
  }

  async function keyWithScopes(scopes: string[]): Promise<string> {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes,
    });
    return key.rawKey;
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
    await publishSkill(ctx);
    await seedInstalledPackage(ctx.defaultSpaceId, SKILL_ID);
  });

  it("403s the index and the file bytes for a key without skills:read", async () => {
    const rawKey = await keyWithScopes(["runs:read"]);

    for (const route of explorerRoutes()) {
      const res = await app.request(route.path, {
        headers: { Authorization: `Bearer ${rawKey}` },
      });
      expect(`${route.label}: ${res.status}`).toBe(`${route.label}: 403`);
      // `/files` inlines text content and `/files/content` IS the bytes, so a
      // status assertion alone would not prove the body stayed shut.
      expect(await res.text()).not.toContain("SECRET SKILL BODY");
    }
  });

  it("serves both routes once the key holds skills:read", async () => {
    const rawKey = await keyWithScopes(["skills:read"]);

    for (const route of explorerRoutes()) {
      const res = await app.request(route.path, {
        headers: { Authorization: `Bearer ${rawKey}` },
      });
      expect(`${route.label}: ${res.status}`).toBe(`${route.label}: 200`);
    }
  });

  it("cannot be bypassed with a replayed If-None-Match", async () => {
    // THE ordering test. Both handlers can answer `304` straight from the
    // resolved validator, before `readPackageSnapshot` runs. A permission
    // check placed after that short-circuit would leave the routes as
    // oracles: replaying a tag obtained elsewhere would confirm that this
    // exact file exists with this exact content. The check therefore has to
    // sit above the validator — in `loadFileExplorerPackage`.
    const allowedKey = await keyWithScopes(["skills:read"]);
    const deniedKey = await keyWithScopes(["runs:read"]);

    for (const route of explorerRoutes().filter((r) => r.label.endsWith("version"))) {
      // 1. An authorized caller obtains a genuine, currently-valid tag.
      const seed = await app.request(route.path, {
        headers: { Authorization: `Bearer ${allowedKey}` },
      });
      expect(`${route.label}: ${seed.status}`).toBe(`${route.label}: 200`);
      const etag = seed.headers.get("etag");
      expect(etag).toBeTruthy();

      // 2. Positive control: the tag really does drive a `304`. Without this
      //    the assertion below could pass because the tag never matched.
      const revalidated = await app.request(route.path, {
        headers: { Authorization: `Bearer ${allowedKey}`, "If-None-Match": etag! },
      });
      expect(`${route.label}: ${revalidated.status}`).toBe(`${route.label}: 304`);

      // 3. The same replay from a key without `skills:read` must be refused,
      //    NOT answered `304`.
      const replayed = await app.request(route.path, {
        headers: { Authorization: `Bearer ${deniedKey}`, "If-None-Match": etag! },
      });
      expect(`${route.label}: ${replayed.status}`).toBe(`${route.label}: 403`);
    }
  });

  it("403s before the file-existence check, so a missing path is indistinguishable", async () => {
    // `404 File not found` is raised after `readPackageSnapshot`. If the guard
    // ran later, an unauthorized caller could tell a real path from a made-up
    // one by the status code alone.
    const rawKey = await keyWithScopes(["runs:read"]);

    const real = await app.request(
      `/api/packages/${SKILL_ID}/files/content?path=SKILL.md&version=0.1.0`,
      { headers: { Authorization: `Bearer ${rawKey}` } },
    );
    const missing = await app.request(
      `/api/packages/${SKILL_ID}/files/content?path=NOPE.md&version=0.1.0`,
      { headers: { Authorization: `Bearer ${rawKey}` } },
    );
    expect(real.status).toBe(403);
    expect(missing.status).toBe(403);
  });

  it("applies the resolved package's type, not a blanket scope", async () => {
    // The routes are registered on the router ROOT — the type is not in the
    // path, it comes from the row. An `agents:read` key must not read a skill.
    const rawKey = await keyWithScopes(["agents:read"]);

    const res = await app.request(`/api/packages/${SKILL_ID}/files`, {
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    expect(res.status).toBe(403);
  });

  it("still 404s (not 403s) a package the calling space cannot see", async () => {
    // Visibility is settled first and deliberately: the RBAC resource comes
    // from the row, so `hasPackageAccess` has to run before the type is known.
    // Same order as `/{version}/download` — permission is held here.
    await db.delete(spacePackages).where(eq(spacePackages.packageId, SKILL_ID));

    const res = await app.request(`/api/packages/${SKILL_ID}/files`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });
});
