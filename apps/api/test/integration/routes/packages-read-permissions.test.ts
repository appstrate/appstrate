// SPDX-License-Identifier: Apache-2.0

/**
 * RBAC on the package READ surface (issue #1123).
 *
 * Every `GET` under `/api/packages` used to be gated on `hasPackageAccess`
 * alone — a visibility check ("is this package a system package, or installed
 * in THIS application?"), never an authorization one. A credential scoped
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
 */

import { describe, it, expect, beforeEach, beforeAll } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
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
      draftContent: "---\nname: read-guard-skill\n---\n\nSECRET SKILL BODY",
    });
    await seedInstalledPackage(ctx.defaultAppId, SKILL_ID);
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
      applicationId: ctx.defaultAppId,
      createdBy: ctx.user.id,
      scopes: ["runs:read"],
    });
    return key.rawKey;
  }

  async function keyWithSkillsRead(): Promise<string> {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
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
    await seedInstalledPackage(ctx.defaultAppId, agentId);

    const key = await seedApiKey({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
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

  /**
   * Publish a real artifact so the route can reach its 200. Without bytes in
   * storage every call answers `404 Artifact not found in storage`, which
   * would make the negative assertions below pass for the wrong reason.
   */
  async function publishSkill(version = "0.1.0"): Promise<void> {
    await seedPackage({ id: SKILL_ID, type: "skill", orgId: ctx.orgId, createdBy: ctx.user.id });

    const zip = zipArtifact({
      "manifest.json": new TextEncoder().encode(
        JSON.stringify({ name: SKILL_ID, version, type: "skill" }),
      ),
      "SKILL.md": new TextEncoder().encode("---\nname: read-guard-skill\n---\n\nSECRET SKILL BODY"),
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

  it("403s a download for a key without the package type's read scope", async () => {
    await publishSkill();
    await seedInstalledPackage(ctx.defaultAppId, SKILL_ID);

    const key = await seedApiKey({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      createdBy: ctx.user.id,
      scopes: ["runs:read"],
    });

    const res = await app.request(`/api/packages/${SKILL_ID}/0.1.0/download`, {
      headers: { Authorization: `Bearer ${key.rawKey}` },
    });
    expect(res.status).toBe(403);
  });

  it("serves the artifact to a key holding skills:read", async () => {
    await publishSkill();
    await seedInstalledPackage(ctx.defaultAppId, SKILL_ID);

    const key = await seedApiKey({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      createdBy: ctx.user.id,
      scopes: ["skills:read"],
    });

    const res = await app.request(`/api/packages/${SKILL_ID}/0.1.0/download`, {
      headers: { Authorization: `Bearer ${key.rawKey}` },
    });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("404s a download for a package that is not installed in the calling application", async () => {
    // Pre-fix this route resolved the row with `orgOrSystemFilter` alone and
    // never called `hasPackageAccess`, so it served artifact bytes for
    // packages the `/files` routes correctly hide. Permission is held here
    // (owner session) — the 404 is the visibility gate, nothing else.
    await publishSkill();

    const res = await app.request(`/api/packages/${SKILL_ID}/0.1.0/download`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });
});
