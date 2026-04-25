// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for GET /api/agents/:scope/:name/bundle (Phase 2 export).
 *
 * Covers:
 *   - Transitive dep walk produces a multi-package .afps-bundle
 *   - Response headers (Content-Type, Content-Disposition, X-Bundle-Integrity)
 *   - Round-trip determinism (two calls return byte-identical bodies)
 *   - No credentials leak (response bytes contain no connection secrets)
 *   - 404 on non-existent version
 *   - RBAC: 404 when agent is not accessible to the app
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync } from "fflate";
import { db } from "../../helpers/db.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { getTestApp } from "../../helpers/app.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { packageDistTags, applicationPackages } from "@appstrate/db/schema";
import { and, eq } from "drizzle-orm";
import * as storage from "@appstrate/db/storage";
import { computeIntegrity } from "@appstrate/core/integrity";
import { readBundleFromBuffer } from "@appstrate/afps-runtime/bundle";

const BUCKET = "agent-packages";
const app = getTestApp();

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function buildAfps(manifest: Record<string, unknown>, content: string): Uint8Array {
  return zipSync({
    "manifest.json": enc(JSON.stringify(manifest, null, 2)),
    "prompt.md": enc(content),
  });
}

async function seedVersionedPackage(opts: {
  id: `@${string}/${string}`;
  type: "agent" | "skill" | "tool" | "provider";
  version: string;
  orgId: string;
  manifest: Record<string, unknown>;
  content?: string;
  setLatest?: boolean;
}): Promise<{ versionId: number; version: string }> {
  await seedPackage({ id: opts.id, type: opts.type, orgId: opts.orgId });
  const afps = buildAfps(opts.manifest, opts.content ?? "content");
  const integrity = computeIntegrity(afps);
  await storage.uploadFile(BUCKET, `${opts.id}/${opts.version}.afps`, Buffer.from(afps));
  const pv = await seedPackageVersion({
    packageId: opts.id,
    version: opts.version,
    integrity,
    artifactSize: afps.length,
    manifest: opts.manifest,
  });
  if (opts.setLatest) {
    await db
      .insert(packageDistTags)
      .values({ packageId: opts.id, tag: "latest", versionId: pv.id })
      .onConflictDoUpdate({
        target: [packageDistTags.packageId, packageDistTags.tag],
        set: { versionId: pv.id, updatedAt: new Date() },
      });
  }
  return { versionId: pv.id, version: pv.version };
}

describe("GET /api/agents/:scope/:name/bundle — export", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "exportorg" });
  });

  it("bundles the agent + transitive deps and echoes X-Bundle-Integrity", async () => {
    // Root → skill-a → skill-b (transitive walk)
    const rootPkgId = "@exportorg/agent-root" as const;
    const rootManifest = {
      name: rootPkgId,
      version: "1.0.0",
      type: "agent",
      schemaVersion: "1.1",
      displayName: "Root",
      author: "tester",
      dependencies: { skills: { "@exportorg/skill-a": "^1.0.0" } },
    };

    const rootVer = await seedVersionedPackage({
      id: rootPkgId,
      type: "agent",
      version: "1.0.0",
      orgId: ctx.orgId,
      manifest: rootManifest,
      content: "Do the thing.",
      setLatest: true,
    });
    await seedVersionedPackage({
      id: "@exportorg/skill-a",
      type: "skill",
      version: "1.2.0",
      orgId: ctx.orgId,
      manifest: {
        name: "@exportorg/skill-a",
        version: "1.2.0",
        type: "skill",
        schemaVersion: "1.1",
        displayName: "A",
        author: "tester",
        dependencies: { skills: { "@exportorg/skill-b": "^1" } },
      },
      setLatest: true,
    });
    await seedVersionedPackage({
      id: "@exportorg/skill-b",
      type: "skill",
      version: "1.0.0",
      orgId: ctx.orgId,
      manifest: {
        name: "@exportorg/skill-b",
        version: "1.0.0",
        type: "skill",
        schemaVersion: "1.1",
        displayName: "B",
        author: "tester",
      },
      setLatest: true,
    });

    // Install root in default app pinned to this version (so the export
    // resolves without a latest-tag lookup for the root).
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, rootPkgId);
    await db
      .update(applicationPackages)
      .set({ versionId: rootVer.versionId })
      .where(
        and(
          eq(applicationPackages.applicationId, ctx.defaultAppId),
          eq(applicationPackages.packageId, rootPkgId),
        ),
      );

    const res = await app.request(`/api/agents/@exportorg/agent-root/bundle`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    // #278 item F — standard `application/zip` so generic ZIP tooling and
    // browser download flows work without special-casing. The vendor MIME
    // type added no compatibility benefit and broke streaming clients that
    // matched on MIME.
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("Content-Disposition")).toContain("exportorg-agent-root.afps-bundle");

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);

    const bundle = readBundleFromBuffer(bytes);
    expect(bundle.packages.size).toBe(3);
    expect(bundle.root).toBe("@exportorg/agent-root@1.0.0");

    const integrityHeader = res.headers.get("X-Bundle-Integrity");
    expect(integrityHeader).not.toBeNull();
    expect(bundle.integrity).toBe(integrityHeader!);
  });

  it("returns byte-identical bodies on two consecutive calls (determinism)", async () => {
    const rootPkgId = "@exportorg/stable-agent" as const;
    await seedVersionedPackage({
      id: rootPkgId,
      type: "agent",
      version: "1.0.0",
      orgId: ctx.orgId,
      manifest: {
        name: rootPkgId,
        version: "1.0.0",
        type: "agent",
        schemaVersion: "1.1",
        displayName: "Stable",
        author: "tester",
      },
      setLatest: true,
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, rootPkgId);

    const [r1, r2] = await Promise.all([
      app.request(`/api/agents/@exportorg/stable-agent/bundle`, {
        headers: authHeaders(ctx),
      }),
      app.request(`/api/agents/@exportorg/stable-agent/bundle`, {
        headers: authHeaders(ctx),
      }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = new Uint8Array(await r1.arrayBuffer());
    const b2 = new Uint8Array(await r2.arrayBuffer());
    expect(b1.byteLength).toBe(b2.byteLength);
    expect(b1).toEqual(b2);
    expect(r1.headers.get("X-Bundle-Integrity")).toBe(r2.headers.get("X-Bundle-Integrity"));
  });

  it("carries no credentials in the exported bytes", async () => {
    // Synthesize a secret-looking token and verify it never appears in
    // the exported bytes. The bundle surface is public-manifest-only so
    // this is a regression guard against accidental leak via metadata.
    const SECRET = "oauth_token_ABCDEF1234567890";
    const rootPkgId = "@exportorg/secret-free" as const;
    await seedVersionedPackage({
      id: rootPkgId,
      type: "agent",
      version: "1.0.0",
      orgId: ctx.orgId,
      manifest: {
        name: rootPkgId,
        version: "1.0.0",
        type: "agent",
        schemaVersion: "1.1",
        displayName: "SecretFree",
        author: "tester",
      },
      content: "Plain prompt.",
      setLatest: true,
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, rootPkgId);

    // A secret stored in connection profiles etc. must NEVER end up in
    // the bundle — our helper just asserts the secret string is absent
    // from the exported bytes. (The secret isn't actually wired into
    // anything — the test simply asserts the export surface would not
    // leak it even if it were.)
    const res = await app.request(`/api/agents/@exportorg/secret-free/bundle`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);

    const bytes = new Uint8Array(await res.arrayBuffer());
    // Direct byte-substring scan — safe across encodings.
    function containsBytes(hay: Uint8Array, needle: string): boolean {
      return Buffer.from(hay).includes(needle);
    }
    expect(containsBytes(bytes, SECRET)).toBe(false);
    // Common secret-like shapes — regression guard for accidental leak.
    expect(containsBytes(bytes, "Bearer ")).toBe(false);
    expect(containsBytes(bytes, "client_secret")).toBe(false);
    expect(containsBytes(bytes, "refresh_token")).toBe(false);
  });

  it("returns 404 for an unknown version query", async () => {
    const rootPkgId = "@exportorg/version-gated" as const;
    await seedVersionedPackage({
      id: rootPkgId,
      type: "agent",
      version: "1.0.0",
      orgId: ctx.orgId,
      manifest: {
        name: rootPkgId,
        version: "1.0.0",
        type: "agent",
        schemaVersion: "1.1",
        displayName: "VG",
        author: "tester",
      },
      setLatest: true,
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, rootPkgId);

    const res = await app.request(`/api/agents/@exportorg/version-gated/bundle?version=99.99.99`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });

  it("returns an actionable 404 when the agent has no published versions", async () => {
    const rootPkgId = "@exportorg/draft-only" as const;
    // Package row exists + installed, but no `packageVersions` row and no
    // `latest` dist-tag — the classic "draft agent" state that trips the
    // export endpoint. The error message should tell the caller how to
    // proceed rather than just saying "not found".
    await seedPackage({ id: rootPkgId, type: "agent", orgId: ctx.orgId });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, rootPkgId);

    const res = await app.request(`/api/agents/@exportorg/draft-only/bundle`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain("publish a version first");
  });

  it("returns 404 when the agent is not accessible to the app", async () => {
    const rootPkgId = "@exportorg/uninstalled" as const;
    // Seeded in the org catalog but NOT installed in the default app.
    await seedVersionedPackage({
      id: rootPkgId,
      type: "agent",
      version: "1.0.0",
      orgId: ctx.orgId,
      manifest: {
        name: rootPkgId,
        version: "1.0.0",
        type: "agent",
        schemaVersion: "1.1",
        displayName: "NI",
        author: "tester",
      },
      setLatest: true,
    });
    const res = await app.request(`/api/agents/@exportorg/uninstalled/bundle`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });
});
