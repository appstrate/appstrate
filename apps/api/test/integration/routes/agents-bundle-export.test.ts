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
 *   - Bundle-layer failures over stored dependency artifacts surface as coded
 *     RFC 9457 422s naming the dependency, not as an opaque 500
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
import { AGENT_PACKAGES_BUCKET, versionZipKey } from "../../../src/services/package-storage.ts";

const app = getTestApp();

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function buildAfps(manifest: Record<string, unknown>, content: string): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "manifest.json": enc(JSON.stringify(manifest, null, 2)),
  };
  // AFPS §3.3/§3.4 companion-file invariants enforced by the bundle loader:
  // agents need a non-empty prompt.md, skills need a SKILL.md with a
  // frontmatter `name`. Emit the right companion for the package type.
  if (manifest.type === "skill") {
    const name = typeof manifest.name === "string" ? manifest.name : "@test/skill";
    files["SKILL.md"] = enc(`---\nname: ${name}\n---\n\n${content}`);
  } else {
    files["prompt.md"] = enc(content);
  }
  return zipSync(files);
}

async function seedVersionedPackage(opts: {
  id: `@${string}/${string}`;
  type: "agent" | "skill";
  version: string;
  orgId: string;
  manifest: Record<string, unknown>;
  content?: string;
  setLatest?: boolean;
  /**
   * Publish these bytes instead of a well-formed AFPS. The recorded integrity
   * still matches them, so the SRI gate passes and any failure is attributable
   * to the archive's contents rather than to corruption.
   */
  artifact?: Uint8Array;
  /**
   * Create the version row with NO object behind it. `truncateAll()` resets the
   * database but not object storage, so absence has to be asserted by deleting
   * the key: a leftover object from an earlier test would otherwise be found
   * with a hash that no longer matches this row, turning the intended
   * `dependency_unresolved` into an `INTEGRITY_MISMATCH`.
   */
  absentArtifact?: boolean;
}): Promise<{ versionId: number; version: string }> {
  await seedPackage({ id: opts.id, type: opts.type, orgId: opts.orgId });
  const afps = opts.artifact ?? buildAfps(opts.manifest, opts.content ?? "content");
  const integrity = computeIntegrity(afps);
  const key = versionZipKey(opts.id, opts.version);
  if (opts.absentArtifact) {
    await storage.deleteFile(AGENT_PACKAGES_BUCKET, key);
  } else {
    await storage.uploadFile(AGENT_PACKAGES_BUCKET, key, Buffer.from(afps));
  }
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
      schema_version: "0.1",
      display_name: "Root",
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
        schema_version: "0.1",
        display_name: "A",
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
        schema_version: "0.1",
        display_name: "B",
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
    // matched on MIME. Filename uses `.afps-bundle.zip` so OS file managers
    // (which dispatch by extension, not MIME) hand the download off to the
    // system archive tool while preserving the AFPS bundle marker.
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("Content-Disposition")).toContain(
      "exportorg-agent-root.afps-bundle.zip",
    );
    // MIME and filename extension must agree — a `.zip` filename with
    // a non-zip MIME, or vice versa, breaks browser download UX on
    // common OSes.
    expect(res.headers.get("Content-Disposition")).toMatch(/\.zip"/);

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);

    const bundle = readBundleFromBuffer(bytes);
    expect(bundle.packages.size).toBe(3);
    expect(bundle.root).toBe("@exportorg/agent-root@1.0.0");

    const integrityHeader = res.headers.get("X-Bundle-Integrity");
    expect(integrityHeader).not.toBeNull();
    // `X-Bundle-Integrity` is the SHA256 of the *wire bytes* — used by
    // clients to detect transport-level corruption against the bytes they
    // just received. The in-archive `bundle.integrity` field is a
    // different AFPS-spec contract (canonical packages-map JSON SRI) and
    // intentionally does NOT equal the zip-bytes SHA — see the route
    // comment in `routes/agents.ts`. The contract under test here is the
    // header-vs-bytes invariant.
    expect(integrityHeader).toBe(computeIntegrity(bytes));
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
        schema_version: "0.1",
        display_name: "Stable",
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
        schema_version: "0.1",
        display_name: "SecretFree",
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
        schema_version: "0.1",
        display_name: "VG",
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

  // ── Bundle-layer failures over stored dependency artifacts ──
  //
  // These assemble from real stored state, so they prove the route reaches
  // `toBundleApiError` at all — without it each one is an opaque 500 carrying
  // neither a code nor the name of the package to fix.

  /** Root agent depending on `@exportorg/dep-skill@^1.0.0`, installed + exportable. */
  async function seedRootWithDependency(ctx: TestContext): Promise<void> {
    const rootPkgId = "@exportorg/dep-root" as const;
    await seedVersionedPackage({
      id: rootPkgId,
      type: "agent",
      version: "1.0.0",
      orgId: ctx.orgId,
      manifest: {
        name: rootPkgId,
        version: "1.0.0",
        type: "agent",
        schema_version: "0.1",
        display_name: "DepRoot",
        author: "tester",
        dependencies: { skills: { "@exportorg/dep-skill": "^1.0.0" } },
      },
      setLatest: true,
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, rootPkgId);
  }

  async function exportDepRoot(ctx: TestContext) {
    return app.request(`/api/agents/@exportorg/dep-root/bundle`, { headers: authHeaders(ctx) });
  }

  it("maps a dependency archive with no manifest.json to 422 bundle_invalid naming it", async () => {
    await seedRootWithDependency(ctx);
    // The artifact the pre-fix skill-only import published: SKILL.md and
    // nothing else, integrity recorded over those same bytes.
    await seedVersionedPackage({
      id: "@exportorg/dep-skill",
      type: "skill",
      version: "1.0.0",
      orgId: ctx.orgId,
      manifest: {
        name: "@exportorg/dep-skill",
        version: "1.0.0",
        type: "skill",
        schema_version: "0.1",
      },
      artifact: zipSync({ "SKILL.md": enc("---\nname: dep-skill\n---\n\nBody.") }),
      setLatest: true,
    });

    const res = await exportDepRoot(ctx);

    expect(res.status).toBe(422);
    expect(res.headers.get("Content-Type")).toContain("application/problem+json");
    const body = (await res.json()) as { code: string; detail: string };
    expect(body.code).toBe("bundle_invalid");
    expect(body.detail).toContain("@exportorg/dep-skill@1.0.0");
    expect(body.detail).toContain("BUNDLE_JSON_INVALID");
  });

  it("maps a dependency whose manifest identity disagrees with the published row to 422 bundle_invalid", async () => {
    await seedRootWithDependency(ctx);
    // Published as 1.0.0, but the stored archive's manifest says 1.0.1 — the
    // shape a republish-under-the-wrong-version leaves behind. Integrity is
    // recorded over these same bytes, so the SRI and signature gates both pass
    // and the only fault is the identity disagreement itself.
    //
    // `buildBundleFromCatalog` is what detects the mismatch, comparing each
    // fetched dependency against the identity it resolved. What this PR adds is
    // the export route's error boundary: that BundleError now surfaces as the
    // RFC 9457 422 asserted below instead of an untyped 500.
    await seedVersionedPackage({
      id: "@exportorg/dep-skill",
      type: "skill",
      version: "1.0.0",
      orgId: ctx.orgId,
      manifest: {
        name: "@exportorg/dep-skill",
        version: "1.0.0",
        type: "skill",
        schema_version: "0.1",
      },
      artifact: buildAfps(
        {
          name: "@exportorg/dep-skill",
          version: "1.0.1",
          type: "skill",
          schema_version: "0.1",
          display_name: "Dep",
          author: "tester",
        },
        "Body.",
      ),
      setLatest: true,
    });

    const res = await exportDepRoot(ctx);

    expect(res.status).toBe(422);
    expect(res.headers.get("Content-Type")).toContain("application/problem+json");
    const body = (await res.json()) as { code: string; detail: string };
    expect(body.code).toBe("bundle_invalid");
    // Detail names both the resolved identity and the one the stored manifest
    // claims, so an operator reads a manifest disagreement, not corrupt bytes.
    expect(body.detail).toContain("@exportorg/dep-skill@1.0.0");
    expect(body.detail).toContain("@exportorg/dep-skill@1.0.1");
    expect(body.detail).toContain("BUNDLE_JSON_INVALID");
  });

  it("maps a dependency version whose object is absent to 422 dependency_unresolved", async () => {
    await seedRootWithDependency(ctx);
    // Object storage outlives truncateAll(); seed stale bytes so absentArtifact
    // must remove them. Without the delete these bytes are found with a hash
    // that no longer matches the row below, and the export fails as a
    // 500 INTEGRITY_MISMATCH instead of the 422 under test.
    await storage.uploadFile(
      AGENT_PACKAGES_BUCKET,
      versionZipKey("@exportorg/dep-skill", "1.0.0"),
      Buffer.from(zipSync({ "SKILL.md": enc("---\nname: dep-skill\n---\n\nBody.") })),
    );
    await seedVersionedPackage({
      id: "@exportorg/dep-skill",
      type: "skill",
      version: "1.0.0",
      orgId: ctx.orgId,
      manifest: {
        name: "@exportorg/dep-skill",
        version: "1.0.0",
        type: "skill",
        schema_version: "0.1",
      },
      absentArtifact: true,
      setLatest: true,
    });

    const res = await exportDepRoot(ctx);

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; detail: string };
    expect(body.code).toBe("dependency_unresolved");
    expect(body.detail).toContain("@exportorg/dep-skill@1.0.0");
    // The pin resolved — pointing the operator at the version range would send
    // them to fix something that is already correct.
    expect(body.detail).not.toContain("fix the pin");
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
        schema_version: "0.1",
        display_name: "NI",
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
