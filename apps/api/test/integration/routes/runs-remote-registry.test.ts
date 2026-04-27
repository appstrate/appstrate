// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `POST /api/runs/remote` — `kind: "registry"` path.
 *
 * The registry path is the deterministic-attribution variant: the runner
 * declares the package by id and the server reads the manifest from its
 * own catalog. No fingerprint reconciliation, no shadow row, no spoof
 * surface. This suite exercises the happy paths (published + draft) and
 * the four 4xx branches the resolver enforces.
 *
 * Out of scope: pipeline dispatch (Docker / sink event ingestion). Same
 * as the inline-run suite — covered by classic-run integration tests.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { buildMinimalZip, uploadPackageZip } from "../../../src/services/package-storage.ts";
import { runs, packages, packageVersions, packageDistTags } from "@appstrate/db/schema";
import { and } from "drizzle-orm";

const app = getTestApp();

const PROMPT = "You are a helpful agent.";

function publishedManifest(version = "1.2.3") {
  return {
    name: "@acme/briefing",
    displayName: "Briefing Agent",
    version,
    type: "agent",
    description: "Test agent",
    schemaVersion: "1.0",
    timeout: 300,
    dependencies: { skills: {}, tools: {}, providers: {} },
  } as const;
}

async function seedPublishedAgent(ctx: TestContext, version = "1.2.3") {
  await seedPackage({
    orgId: ctx.orgId,
    id: "@acme/briefing",
    type: "agent",
    draftManifest: publishedManifest(version) as unknown as Record<string, unknown>,
    draftContent: PROMPT,
  });
  const versionRow = await seedPackageVersion({
    packageId: "@acme/briefing",
    version,
    integrity: "sha256-test",
    artifactSize: 1024,
    manifest: publishedManifest(version) as unknown as Record<string, unknown>,
  });
  // Set the `latest` dist-tag so the unspecified-spec resolution path
  // works — `seedPackageVersion` is a thin INSERT and doesn't touch
  // `package_dist_tags` (the `createPackageVersion` service does that on
  // the publish flow).
  await db
    .insert(packageDistTags)
    .values({ packageId: "@acme/briefing", tag: "latest", versionId: versionRow.id });
  // Upload the artefact so getVersionDetail can extract textContent.
  const zip = buildMinimalZip(
    publishedManifest(version) as unknown as Record<string, unknown>,
    PROMPT,
  );
  await uploadPackageZip("@acme/briefing", version, zip);
  await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, "@acme/briefing");
}

describe("POST /api/runs/remote — kind: registry", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "acme" });
  });

  async function post(body: unknown) {
    return app.request("/api/runs/remote", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("creates a run attributed to the published version (no shadow row)", async () => {
    await seedPublishedAgent(ctx, "1.2.3");

    const res = await post({
      source: {
        kind: "registry",
        packageId: "@acme/briefing",
        stage: "published",
        spec: "1.2.3",
      },
      applicationId: ctx.defaultAppId,
      input: {},
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { runId: string };
    expect(body.runId).toBeString();

    // Run is attributed to the real package, not a shadow row.
    const [run] = await db.select().from(runs).where(eq(runs.id, body.runId)).limit(1);
    expect(run).toBeDefined();
    expect(run!.packageId).toBe("@acme/briefing");
    expect(run!.versionLabel).toBe("1.2.3");

    // No ephemeral shadow package was created.
    const ephemerals = await db
      .select({ id: packages.id })
      .from(packages)
      .where(eq(packages.ephemeral, true));
    expect(ephemerals).toHaveLength(0);
  });

  it("resolves `latest` when no spec is supplied", async () => {
    await seedPublishedAgent(ctx, "1.0.0");

    const res = await post({
      source: { kind: "registry", packageId: "@acme/briefing", stage: "published" },
      applicationId: ctx.defaultAppId,
      input: {},
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { runId: string };
    const [run] = await db.select().from(runs).where(eq(runs.id, body.runId)).limit(1);
    expect(run!.versionLabel).toBe("1.0.0");
  });

  it("creates a draft run with versionLabel `draft`", async () => {
    await seedPackage({
      orgId: ctx.orgId,
      id: "@acme/draft-only",
      type: "agent",
      draftManifest: {
        name: "@acme/draft-only",
        displayName: "Draft-only Agent",
        version: "0.0.1",
        type: "agent",
        schemaVersion: "1.0",
        dependencies: { skills: {}, tools: {}, providers: {} },
      } as unknown as Record<string, unknown>,
      draftContent: "draft prompt",
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, "@acme/draft-only");

    const res = await post({
      source: { kind: "registry", packageId: "@acme/draft-only", stage: "draft" },
      applicationId: ctx.defaultAppId,
      input: {},
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { runId: string };
    const [run] = await db.select().from(runs).where(eq(runs.id, body.runId)).limit(1);
    expect(run!.packageId).toBe("@acme/draft-only");
    expect(run!.versionLabel).toBe("draft");
  });

  it("rejects a malformed draft manifest with 400", async () => {
    // Seed a draft that's missing required AFPS fields (no `displayName`,
    // no `schemaVersion`). The full-AFPS validator must catch this here
    // instead of letting the run pipeline crash later with a less
    // actionable error.
    await seedPackage({
      orgId: ctx.orgId,
      id: "@acme/broken-draft",
      type: "agent",
      draftManifest: {
        name: "@acme/broken-draft",
        version: "0.0.1",
        type: "agent",
        // displayName + schemaVersion intentionally omitted
        dependencies: { skills: {}, tools: {}, providers: {} },
      } as unknown as Record<string, unknown>,
      draftContent: "draft prompt",
    });
    await installPackage(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      "@acme/broken-draft",
    );

    const res = await post({
      source: { kind: "registry", packageId: "@acme/broken-draft", stage: "draft" },
      applicationId: ctx.defaultAppId,
      input: {},
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("invalid_draft_manifest");
  });

  it("rejects a missing package with 404", async () => {
    const res = await post({
      source: { kind: "registry", packageId: "@acme/does-not-exist", stage: "published" },
      applicationId: ctx.defaultAppId,
      input: {},
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("package_not_found");
  });

  it("rejects an uninstalled package with 404", async () => {
    // Seed an org-owned package + version but DON'T install it in the app.
    await seedPackage({
      orgId: ctx.orgId,
      id: "@acme/briefing",
      type: "agent",
      draftManifest: publishedManifest() as unknown as Record<string, unknown>,
      draftContent: PROMPT,
    });
    await seedPackageVersion({
      packageId: "@acme/briefing",
      version: "1.2.3",
      integrity: "sha256-test",
      artifactSize: 1024,
      manifest: publishedManifest() as unknown as Record<string, unknown>,
    });

    const res = await post({
      source: { kind: "registry", packageId: "@acme/briefing", stage: "published" },
      applicationId: ctx.defaultAppId,
      input: {},
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("package_not_installed_in_app");
  });

  it("rejects an unresolvable spec with 404", async () => {
    await seedPublishedAgent(ctx, "1.0.0");
    const res = await post({
      source: {
        kind: "registry",
        packageId: "@acme/briefing",
        stage: "published",
        spec: "9.9.9",
      },
      applicationId: ctx.defaultAppId,
      input: {},
    });
    expect(res.status).toBe(404);
  });

  it("rejects a yanked version with 410", async () => {
    await seedPublishedAgent(ctx, "1.0.0");
    // No exported yankVersion helper today — flip the column directly. The
    // service contract under test is the resolver's behaviour on yanked
    // rows, not the yank workflow itself (which lives in the publish flow).
    await db
      .update(packageVersions)
      .set({ yanked: true, yankedReason: "compromised" })
      .where(
        and(eq(packageVersions.packageId, "@acme/briefing"), eq(packageVersions.version, "1.0.0")),
      );

    const res = await post({
      source: {
        kind: "registry",
        packageId: "@acme/briefing",
        stage: "published",
        spec: "1.0.0",
      },
      applicationId: ctx.defaultAppId,
      input: {},
    });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("version_yanked");
  });

  it("rejects `stage: draft` combined with a spec (400)", async () => {
    await seedPublishedAgent(ctx, "1.0.0");
    const res = await post({
      source: {
        kind: "registry",
        packageId: "@acme/briefing",
        stage: "draft",
        spec: "1.0.0",
      },
      applicationId: ctx.defaultAppId,
      input: {},
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("draft_with_spec");
  });

  it("accepts an integrity hint without rejecting on drift", async () => {
    await seedPublishedAgent(ctx, "1.2.3");
    const res = await post({
      source: {
        kind: "registry",
        packageId: "@acme/briefing",
        stage: "published",
        spec: "1.2.3",
        integrity: "sha256-totally-bogus-hint",
      },
      applicationId: ctx.defaultAppId,
      input: {},
    });
    // Drift hint is observational only — the run still succeeds.
    expect(res.status).toBe(201);
  });
});
