// SPDX-License-Identifier: Apache-2.0

/**
 * RBAC on the DEPENDENCY bytes of `GET /api/agents/:scope/:name/bundle`.
 *
 * #1123 / #1124 settled that a skill's stored bytes need `skills:read`, per
 * package TYPE rather than one blanket scope — that is what
 * `GET /api/packages/skills/{id}/files[/content]` enforces.
 *
 * The bundle export was the remaining looser door to the same bytes. It is
 * registered under `agents:read` alone, and while the ROOT agent is narrowed to
 * `manifest.json` + `prompt.md`, every dependency goes in whole: the draft path
 * reads `downloadPackageFiles` unfiltered (`DraftPackageCatalog.fetch`) and the
 * published path extracts the entire stored artifact (`DbPackageCatalog.fetch`).
 * So an `agents:read`-only credential was 403'd on the file explorer and served
 * the identical `SKILL.md` here.
 *
 * The scoped API key is the only credential that can express "authenticated for
 * this org, without `skills:read`" — every org ROLE that carries `agents:read`
 * also carries `skills:read` (owner/admin/member/viewer alike), which is exactly
 * why this gap was invisible from the SPA. The role case below pins that the fix
 * is a no-op for sessions.
 *
 * What deliberately did NOT change: dependency resolution stays org-scoped in
 * both catalogs, so a skill that is not installed in the calling application is
 * still exported. That is the rule the RUN path uses (`DraftPackageCatalog` is
 * shared with `RunPackageCatalog`), and narrowing the export to
 * `hasPackageAccess` would make it stricter than the run it mirrors. The skill
 * below is therefore never installed in the app — the fix has to be about SCOPE,
 * not visibility, and the positive controls prove it.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync } from "fflate";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageVersion, seedApiKey } from "../../helpers/seed.ts";
import { getTestApp } from "../../helpers/app.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { uploadPackageFiles } from "../../../src/services/package-items/storage.ts";
import { buildAgentPackage } from "../../../src/services/package-storage.ts";
import { packageDistTags } from "@appstrate/db/schema";
import * as storage from "@appstrate/db/storage";
import { computeIntegrity } from "@appstrate/core/integrity";
import { readBundleFromBuffer } from "@appstrate/afps-runtime/bundle";
import {
  AGENT_PACKAGES_BUCKET,
  versionZipKey,
} from "../../../src/services/package-storage-keys.ts";
import type { AgentManifest, LoadedPackage } from "../../../src/types/index.ts";

const app = getTestApp();

const AGENT_ID = "@scopeorg/dep-agent";
const BARE_AGENT_ID = "@scopeorg/bare-agent";
const SKILL_ID = "@scopeorg/secret-skill";
/** Distinctive marker: any 200 that carries it proves the bytes were served. */
const SKILL_SECRET = "SECRET SKILL BODY";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function skillManifest(version: string) {
  return {
    name: SKILL_ID,
    version,
    type: "skill",
    schema_version: "0.1",
    display_name: "Secret Skill",
    author: "tester",
  };
}

function agentManifest(id: string, opts: { withSkillDep: boolean }) {
  return {
    name: id,
    version: "1.0.0",
    type: "agent",
    schema_version: "0.1",
    display_name: "Dep Agent",
    author: "tester",
    ...(opts.withSkillDep ? { dependencies: { skills: { [SKILL_ID]: "^1.0.0" } } } : {}),
  };
}

/** Publish `(id, version)`: artifact in the versions bucket + row + `latest`. */
async function publish(
  id: string,
  version: string,
  manifest: Record<string, unknown>,
  companion: Record<string, Uint8Array>,
): Promise<void> {
  const afps = zipSync({
    "manifest.json": enc(JSON.stringify(manifest, null, 2)),
    ...companion,
  });
  await storage.uploadFile(AGENT_PACKAGES_BUCKET, versionZipKey(id, version), Buffer.from(afps));
  const pv = await seedPackageVersion({
    packageId: id,
    version,
    integrity: computeIntegrity(afps),
    artifactSize: afps.length,
    manifest,
  });
  await db
    .insert(packageDistTags)
    .values({ packageId: id, tag: "latest", versionId: pv.id })
    .onConflictDoUpdate({
      target: [packageDistTags.packageId, packageDistTags.tag],
      set: { versionId: pv.id, updatedAt: new Date() },
    });
}

async function keyWithScopes(ctx: TestContext, scopes: string[]): Promise<string> {
  const key = await seedApiKey({
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    createdBy: ctx.user.id,
    scopes,
  });
  return key.rawKey;
}

function bearer(rawKey: string): Record<string, string> {
  return { Authorization: `Bearer ${rawKey}` };
}

describe("GET /api/agents/:scope/:name/bundle — dependency read scope", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "scopeorg" });

    // Root agent: declares the skill, installed in the default app.
    await seedPackage({
      id: AGENT_ID,
      type: "agent",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: agentManifest(AGENT_ID, { withSkillDep: true }),
      draftContent: "You are the agent.",
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, AGENT_ID);
    await publish(AGENT_ID, "1.0.0", agentManifest(AGENT_ID, { withSkillDep: true }), {
      "prompt.md": enc("You are the agent."),
    });

    // Dependency skill: draft bytes in the package-items bucket + a published
    // version. Deliberately NOT installed in the application — the export
    // reaches it exactly like a run does, and must keep doing so.
    await seedPackage({
      id: SKILL_ID,
      type: "skill",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: skillManifest("1.0.0"),
      draftContent: SKILL_SECRET,
    });
    await uploadPackageFiles("skills", ctx.orgId, SKILL_ID, {
      "manifest.json": enc(JSON.stringify(skillManifest("1.0.0"), null, 2)),
      "SKILL.md": enc(`---\nname: ${SKILL_ID}\n---\n\n${SKILL_SECRET}`),
    });
    await publish(SKILL_ID, "1.0.0", skillManifest("1.0.0"), {
      "SKILL.md": enc(`---\nname: ${SKILL_ID}\n---\n\n${SKILL_SECRET}`),
    });
  });

  // ── Negative controls: the principal who could reach the bytes, and now cannot

  it("403s ?source=draft for a key with agents:read but no skills:read", async () => {
    const rawKey = await keyWithScopes(ctx, ["agents:read"]);

    const res = await app.request(`/api/agents/${AGENT_ID}/bundle?source=draft`, {
      headers: bearer(rawKey),
    });

    expect(res.status).toBe(403);
    // The whole point is the bytes, so assert on them and not just the status:
    // a 403 that still streamed the archive would pass a status-only check.
    expect(await res.text()).not.toContain(SKILL_SECRET);
  });

  it("403s the published export for the same key — the leak is not draft-specific", async () => {
    // `DbPackageCatalog.fetch` extracts the whole stored artifact too, so
    // gating only `?source=draft` would leave the default export wide open.
    const rawKey = await keyWithScopes(ctx, ["agents:read"]);

    const res = await app.request(`/api/agents/${AGENT_ID}/bundle`, { headers: bearer(rawKey) });

    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(SKILL_SECRET);
  });

  // ── Positive controls: whoever legitimately exports still exports

  it("serves ?source=draft once the key also holds skills:read", async () => {
    const rawKey = await keyWithScopes(ctx, ["agents:read", "skills:read"]);

    const res = await app.request(`/api/agents/${AGENT_ID}/bundle?source=draft`, {
      headers: bearer(rawKey),
    });

    expect(res.status).toBe(200);
    const bundle = readBundleFromBuffer(new Uint8Array(await res.arrayBuffer()));
    expect(bundle.packages.size).toBe(2);
    // The skill is NOT installed in this application and is still exported —
    // the guard added is about SCOPE, never about narrowing reach to
    // `hasPackageAccess` (which would break the run this export mirrors).
    const skill = bundle.packages.get(`${SKILL_ID}@1.0.0`);
    expect(skill).toBeDefined();
    expect(new TextDecoder().decode(skill!.files.get("SKILL.md"))).toContain(SKILL_SECRET);
  });

  it("serves the published export once the key also holds skills:read", async () => {
    const rawKey = await keyWithScopes(ctx, ["agents:read", "skills:read"]);

    const res = await app.request(`/api/agents/${AGENT_ID}/bundle`, { headers: bearer(rawKey) });

    expect(res.status).toBe(200);
    const bundle = readBundleFromBuffer(new Uint8Array(await res.arrayBuffer()));
    expect(bundle.packages.size).toBe(2);
  });

  it("keeps org-role sessions unaffected — every role with agents:read has skills:read", async () => {
    // The blast radius of this change is scoped credentials only. If a role
    // ever loses `skills:read` while keeping `agents:read`, this fails loudly
    // rather than silently 403ing the dashboard's export button.
    for (const source of ["draft", "published"]) {
      const res = await app.request(`/api/agents/${AGENT_ID}/bundle?source=${source}`, {
        headers: authHeaders(ctx),
      });
      expect(`${source}: ${res.status}`).toBe(`${source}: 200`);
    }
  });

  it("still serves a dependency-free agent to an agents:read-only key", async () => {
    // The guard is charged against the bytes actually in the archive, not
    // levied as a blanket second scope on the route: an agent with no skill
    // dependency ships no skill bytes and needs no skill scope.
    await seedPackage({
      id: BARE_AGENT_ID,
      type: "agent",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: agentManifest(BARE_AGENT_ID, { withSkillDep: false }),
      draftContent: "Bare agent.",
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, BARE_AGENT_ID);
    const rawKey = await keyWithScopes(ctx, ["agents:read"]);

    const res = await app.request(`/api/agents/${BARE_AGENT_ID}/bundle?source=draft`, {
      headers: bearer(rawKey),
    });

    expect(res.status).toBe(200);
    const bundle = readBundleFromBuffer(new Uint8Array(await res.arrayBuffer()));
    expect(bundle.packages.size).toBe(1);
  });

  // ── The regression that would hurt most: the run path is untouched

  it("still resolves the same draft dependency on the RUN path", async () => {
    // `DraftPackageCatalog` is SHARED with the run path (`RunPackageCatalog`
    // routes a `"draft"` dependency override to it), so the fix stayed out of
    // its query on purpose. This pins the behaviour that tightening it would
    // have broken: a run resolves a draft skill that is not installed in the
    // calling application, with no `skills:read` anywhere in the picture.
    const agent: LoadedPackage = {
      id: AGENT_ID,
      manifest: agentManifest(AGENT_ID, { withSkillDep: true }) as unknown as AgentManifest,
      prompt: "You are the agent.",
      source: "local",
    };

    const built = await buildAgentPackage(agent, ctx.orgId, { [SKILL_ID]: "draft" });

    const bundle = readBundleFromBuffer(new Uint8Array(built.zip));
    const skill = bundle.packages.get(`${SKILL_ID}@1.0.0`);
    expect(skill).toBeDefined();
    expect(new TextDecoder().decode(skill!.files.get("SKILL.md"))).toContain(SKILL_SECRET);

    // The skill row and its bytes plainly exist (asserted above), so this 404
    // is the app-install boundary and nothing else — the run reached bytes the
    // file explorer refuses to show. That asymmetry is the run path's own rule,
    // deliberately left alone.
    const res = await app.request(`/api/packages/skills/${SKILL_ID}/files`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });
});
