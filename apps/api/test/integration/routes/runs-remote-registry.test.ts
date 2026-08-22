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
import { validateManifest } from "@appstrate/core/validation";
import { and } from "drizzle-orm";

const app = getTestApp();

const PROMPT = "You are a helpful agent.";

function publishedManifest(version = "1.2.3") {
  return {
    name: "@acme/briefing",
    display_name: "Briefing Agent",
    version,
    type: "agent",
    description: "Test agent",
    schema_version: "0.1",
    author: "tester",
    timeout: 300,
    dependencies: { skills: {}, mcp_servers: {}, integrations: {} },
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
  // Upload the artefact so getVersionDetail can extract the prompt.
  const zip = buildMinimalZip(
    publishedManifest(version) as unknown as Record<string, unknown>,
    PROMPT,
  );
  await uploadPackageZip("@acme/briefing", version, zip);
  await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, "@acme/briefing");
}

/**
 * Manifest with a single file input field (`format: "uri"` + `contentMediaType`).
 * Used to exercise the remote file-input gate: platform-stored URIs
 * (`upload://` / `appfile://`) are rejected because a remote run executes on
 * the caller's host, whose workspace the platform never provisions.
 */
function fileInputManifest(version = "3.0.0") {
  return {
    ...publishedManifest(version),
    input: {
      schema: {
        type: "object",
        properties: {
          file: { type: "string", format: "uri", contentMediaType: "application/pdf" },
        },
      },
    },
  } as const;
}

async function seedFileInputAgent(ctx: TestContext, version = "3.0.0") {
  const manifest = fileInputManifest(version) as unknown as Record<string, unknown>;
  await seedPackage({
    orgId: ctx.orgId,
    id: "@acme/briefing",
    type: "agent",
    draftManifest: manifest,
    draftContent: PROMPT,
  });
  const versionRow = await seedPackageVersion({
    packageId: "@acme/briefing",
    version,
    integrity: "sha256-test",
    artifactSize: 1024,
    manifest,
  });
  await db
    .insert(packageDistTags)
    .values({ packageId: "@acme/briefing", tag: "latest", versionId: versionRow.id });
  await uploadPackageZip("@acme/briefing", version, buildMinimalZip(manifest, PROMPT));
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
    const body = (await res.json()) as { id: string; runId?: unknown };
    expect(body.id).toBeString();
    // Legacy `runId` alias removed (#657) — the envelope carries `id`.
    expect(body.runId).toBeUndefined();

    // Run is attributed to the real package, not a shadow row.
    const [run] = await db.select().from(runs).where(eq(runs.id, body.id)).limit(1);
    expect(run).toBeDefined();
    expect(run!.packageId).toBe("@acme/briefing");
    expect(run!.versionLabel).toBe("1.2.3");
    expect(run!.versionRef).toBe("1.2.3");

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
    const body = (await res.json()) as { id: string };
    const [run] = await db.select().from(runs).where(eq(runs.id, body.id)).limit(1);
    expect(run!.versionLabel).toBe("1.0.0");
    expect(run!.versionRef).toBe("1.0.0");
  });

  it("still runs a published version whose manifest names a retired runtime tool", async () => {
    // The whole reason the read direction DROPS instead of rejecting: a
    // published version is an immutable, integrity-checked artifact. Once the
    // platform retires a `runtime_tools` id, every already-published manifest
    // naming it would 500 on `invalid_stored_manifest` forever — unfixable
    // without republishing, which the org may not even be able to do.
    // Author input still rejects the same id (write direction); only this
    // persisted-read path drops it.
    const version = "2.0.0";
    const manifest = {
      ...publishedManifest(version),
      // `log` is live, `report` was retired — only the retired one may go.
      runtime_tools: ["log", "report"],
    } as unknown as Record<string, unknown>;

    // Non-vacuity guard: if `report` were ever re-admitted to the catalog this
    // test would pass while exercising nothing. Assert it is genuinely retired
    // by checking the WRITE direction still refuses the same manifest.
    const asAuthorInput = validateManifest(manifest);
    expect(asAuthorInput.valid).toBe(false);

    await seedPackage({
      orgId: ctx.orgId,
      id: "@acme/briefing",
      type: "agent",
      draftManifest: manifest,
      draftContent: PROMPT,
    });
    const versionRow = await seedPackageVersion({
      packageId: "@acme/briefing",
      version,
      integrity: "sha256-test",
      artifactSize: 1024,
      manifest,
    });
    await db
      .insert(packageDistTags)
      .values({ packageId: "@acme/briefing", tag: "latest", versionId: versionRow.id });
    await uploadPackageZip("@acme/briefing", version, buildMinimalZip(manifest, PROMPT));
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, "@acme/briefing");

    const res = await post({
      source: { kind: "registry", packageId: "@acme/briefing", stage: "published", spec: version },
      applicationId: ctx.defaultAppId,
      input: {},
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const [run] = await db.select().from(runs).where(eq(runs.id, body.id)).limit(1);
    expect(run!.packageId).toBe("@acme/briefing");
    expect(run!.versionRef).toBe(version);
  });

  it("still runs a published version whose manifest carries a retired AFPS 1.x dependency key", async () => {
    // Same doctrine as the retired-`runtime_tools` test above, applied to the
    // `dependencies.tools` / `dependencies.providers` keys AFPS 2.0 retired
    // (#1021). Author input rejects them; a PUBLISHED manifest carrying one
    // must keep validating, because it is re-validated on every run and the
    // artifact is immutable + integrity-checked — closing `dependencies` would
    // make such an agent permanently unrunnable with no repair path.
    const version = "2.2.0";
    const manifest = {
      ...publishedManifest(version),
      dependencies: { tools: { "@appstrate/report": "^1.0.0" } },
    } as unknown as Record<string, unknown>;

    // Non-vacuity guard: the WRITE direction must still refuse this exact
    // manifest, otherwise the 201 below proves nothing.
    expect(validateManifest(manifest).valid).toBe(false);

    await seedPackage({
      orgId: ctx.orgId,
      id: "@acme/briefing",
      type: "agent",
      draftManifest: manifest,
      draftContent: PROMPT,
    });
    const versionRow = await seedPackageVersion({
      packageId: "@acme/briefing",
      version,
      integrity: "sha256-test",
      artifactSize: 1024,
      manifest,
    });
    await db
      .insert(packageDistTags)
      .values({ packageId: "@acme/briefing", tag: "latest", versionId: versionRow.id });
    await uploadPackageZip("@acme/briefing", version, buildMinimalZip(manifest, PROMPT));
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, "@acme/briefing");

    const res = await post({
      source: { kind: "registry", packageId: "@acme/briefing", stage: "published", spec: version },
      applicationId: ctx.defaultAppId,
      input: {},
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const [run] = await db.select().from(runs).where(eq(runs.id, body.id)).limit(1);
    expect(run!.packageId).toBe("@acme/briefing");
    expect(run!.versionRef).toBe(version);
  });

  it("rejects a published version whose stored manifest is malformed with 500", async () => {
    // The counterpart of the test above, and what makes it mean something: a
    // stored manifest the validator refuses DOES fail the run. So the 201
    // there is not the route being lenient — it is the retired-id drop, and
    // the day the read path stops dropping, that test lands on this 500.
    const version = "2.1.0";
    const { display_name: _omitted, ...withoutDisplayName } = publishedManifest(version);
    const manifest = withoutDisplayName as unknown as Record<string, unknown>;

    await seedPackage({
      orgId: ctx.orgId,
      id: "@acme/briefing",
      type: "agent",
      // The draft column keeps a valid manifest: only the published snapshot
      // is malformed, so the failure can only come from the published path.
      draftManifest: publishedManifest(version) as unknown as Record<string, unknown>,
      draftContent: PROMPT,
    });
    const versionRow = await seedPackageVersion({
      packageId: "@acme/briefing",
      version,
      integrity: "sha256-test",
      artifactSize: 1024,
      manifest,
    });
    await db
      .insert(packageDistTags)
      .values({ packageId: "@acme/briefing", tag: "latest", versionId: versionRow.id });
    await uploadPackageZip("@acme/briefing", version, buildMinimalZip(manifest, PROMPT));
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, "@acme/briefing");

    const res = await post({
      source: { kind: "registry", packageId: "@acme/briefing", stage: "published", spec: version },
      applicationId: ctx.defaultAppId,
      input: {},
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("invalid_stored_manifest");
  });

  it("creates a draft run with versionLabel `draft`", async () => {
    await seedPackage({
      orgId: ctx.orgId,
      id: "@acme/draft-only",
      type: "agent",
      draftManifest: {
        name: "@acme/draft-only",
        display_name: "Draft-only Agent",
        version: "0.0.1",
        type: "agent",
        schema_version: "0.1",
        author: "tester",
        dependencies: { skills: {}, mcp_servers: {}, integrations: {} },
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
    const body = (await res.json()) as { id: string };
    const [run] = await db.select().from(runs).where(eq(runs.id, body.id)).limit(1);
    expect(run!.packageId).toBe("@acme/draft-only");
    expect(run!.versionLabel).toBe("draft");
    expect(run!.versionRef).toBe("draft");
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
        dependencies: { skills: {}, mcp_servers: {}, integrations: {} },
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

  it("rejects a dependency_overrides key the agent does not declare (400)", async () => {
    await seedPublishedAgent(ctx, "1.2.3");

    const res = await post({
      source: { kind: "registry", packageId: "@acme/briefing", stage: "published", spec: "1.2.3" },
      applicationId: ctx.defaultAppId,
      input: {},
      // Mirrors the platform run route: the freeze KEY gate runs on remote too.
      dependency_overrides: { "@acme/not-a-dep": "draft" },
    });

    expect(res.status).toBe(400);
  });

  it("rejects a malformed dependency_overrides value (400)", async () => {
    await seedPublishedAgent(ctx, "1.2.3");

    const res = await post({
      source: { kind: "registry", packageId: "@acme/briefing", stage: "published", spec: "1.2.3" },
      applicationId: ctx.defaultAppId,
      input: {},
      dependency_overrides: { "@acme/briefing": "not a version!!" },
    });

    expect(res.status).toBe(400);
  });

  it("forwards a declared dependency_overrides onto the run row", async () => {
    // Skill the agent depends on — must exist + be installed so readiness
    // passes and the run reaches the dependency-freeze + row insert.
    await seedPackage({
      orgId: ctx.orgId,
      id: "@acme/helper",
      type: "skill",
      draftManifest: {
        name: "@acme/helper",
        display_name: "Helper",
        version: "1.0.0",
        type: "skill",
        schema_version: "0.1",
        author: "tester",
      } as unknown as Record<string, unknown>,
      draftContent: "helper",
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, "@acme/helper");

    // Agent declaring a skill dependency — its id is a valid override KEY.
    const manifest = {
      name: "@acme/briefing",
      display_name: "Briefing Agent",
      version: "2.0.0",
      type: "agent",
      description: "Test agent",
      schema_version: "0.1",
      author: "tester",
      timeout: 300,
      dependencies: { skills: { "@acme/helper": "^1.0.0" }, mcp_servers: {}, integrations: {} },
    } as unknown as Record<string, unknown>;
    await seedPackage({
      orgId: ctx.orgId,
      id: "@acme/briefing",
      type: "agent",
      draftManifest: manifest,
      draftContent: PROMPT,
    });
    const versionRow = await seedPackageVersion({
      packageId: "@acme/briefing",
      version: "2.0.0",
      integrity: "sha256-test",
      artifactSize: 1024,
      manifest,
    });
    await db
      .insert(packageDistTags)
      .values({ packageId: "@acme/briefing", tag: "latest", versionId: versionRow.id });
    await uploadPackageZip("@acme/briefing", "2.0.0", buildMinimalZip(manifest, PROMPT));
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, "@acme/briefing");

    const res = await post({
      source: { kind: "registry", packageId: "@acme/briefing", stage: "published", spec: "2.0.0" },
      applicationId: ctx.defaultAppId,
      input: {},
      dependency_overrides: { "@acme/helper": "draft" },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const [run] = await db.select().from(runs).where(eq(runs.id, body.id)).limit(1);
    expect(run!.dependencyOverrides).toEqual({ "@acme/helper": "draft" });
  });

  it("rejects an appfile:// file input with an explanatory 400", async () => {
    await seedFileInputAgent(ctx, "3.0.0");

    const res = await post({
      source: { kind: "registry", packageId: "@acme/briefing", stage: "published", spec: "3.0.0" },
      applicationId: ctx.defaultAppId,
      input: { file: "appfile://doc_abc123" },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; detail?: string; param?: string };
    expect(body.code).toBe("invalid_request");
    expect(body.param).toBe("file");
    // The message must explain WHY (remote host) and point at the fix (data:).
    expect(body.detail).toContain("not supported on remote runs");
    expect(body.detail).toContain("data:");
  });

  it("rejects an upload:// file input with an explanatory 400", async () => {
    await seedFileInputAgent(ctx, "3.0.0");

    const res = await post({
      source: { kind: "registry", packageId: "@acme/briefing", stage: "published", spec: "3.0.0" },
      applicationId: ctx.defaultAppId,
      input: { file: "upload://upl_abc123" },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; detail?: string; param?: string };
    expect(body.code).toBe("invalid_request");
    expect(body.param).toBe("file");
    expect(body.detail).toContain("not supported on remote runs");
  });

  it("passes the file-input gate for a self-contained data: URI", async () => {
    await seedFileInputAgent(ctx, "3.0.0");

    const res = await post({
      source: { kind: "registry", packageId: "@acme/briefing", stage: "published", spec: "3.0.0" },
      applicationId: ctx.defaultAppId,
      input: { file: "data:application/pdf;name=report.pdf;base64,JVBERi0=" },
    });

    // `data:` is self-contained (the remote runner materializes it itself), so
    // it must NOT trip the platform-stored-file gate — remote run creation has
    // no downstream launch step, so the request goes all the way to 201.
    expect(res.status).toBe(201);
  });

  // `source.modelId` / `source.proxyId` used to be accepted (and validated)
  // on this route while `run-creation.ts` never read them — the pin the
  // OpenAPI advertised was silently dropped and `runs.model_label` /
  // `runs.model_source` stayed NULL. The fields are gone from the contract;
  // both source variants are `.strict()` so a stale client fails loudly
  // instead of believing its pin took effect.
  it("rejects `source.modelId` on the registry shape with 400", async () => {
    await seedPublishedAgent(ctx, "1.2.3");

    const res = await post({
      source: {
        kind: "registry",
        packageId: "@acme/briefing",
        stage: "published",
        spec: "1.2.3",
        modelId: "gpt-4o",
      },
      applicationId: ctx.defaultAppId,
      input: {},
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; detail?: string };
    expect(body.code).toBe("validation_failed");
    expect(body.detail).toContain("modelId");

    // Nothing was created — the body never reached run creation.
    const created = await db.select({ id: runs.id }).from(runs);
    expect(created).toHaveLength(0);
  });

  it("rejects `source.proxyId` on the registry shape with 400", async () => {
    await seedPublishedAgent(ctx, "1.2.3");

    const res = await post({
      source: {
        kind: "registry",
        packageId: "@acme/briefing",
        stage: "published",
        spec: "1.2.3",
        proxyId: "none",
      },
      applicationId: ctx.defaultAppId,
      input: {},
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; detail?: string };
    expect(body.code).toBe("validation_failed");
    expect(body.detail).toContain("proxyId");

    const created = await db.select({ id: runs.id }).from(runs);
    expect(created).toHaveLength(0);
  });

  it("rejects `source.modelId` on the inline shape with 400", async () => {
    const res = await post({
      source: {
        kind: "inline",
        manifest: publishedManifest("0.0.1"),
        prompt: PROMPT,
        modelId: "gpt-4o",
      },
      applicationId: ctx.defaultAppId,
      input: {},
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; detail?: string };
    expect(body.code).toBe("validation_failed");
    expect(body.detail).toContain("modelId");

    // No shadow package leaked either — the reject happens at body parsing.
    const ephemerals = await db
      .select({ id: packages.id })
      .from(packages)
      .where(eq(packages.ephemeral, true));
    expect(ephemerals).toHaveLength(0);
  });

  it("carries an author default into the run the inline shape creates", async () => {
    // Regression: the inline preflight used to validate the RESOLVED input
    // and return the RAW body, so a required field satisfied only by a schema
    // `default` passed the gate and reached the runner absent. Assert on what
    // the run actually stores, not on the validation verdict — the whole
    // defect is that the two disagreed.
    const res = await post({
      source: {
        kind: "inline",
        manifest: {
          ...publishedManifest("0.0.1"),
          input: {
            schema: {
              type: "object",
              required: ["tone"],
              properties: { tone: { type: "string", default: "formal" } },
            },
          },
        },
        prompt: PROMPT,
      },
      applicationId: ctx.defaultAppId,
      input: {},
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const [run] = await db.select().from(runs).where(eq(runs.id, body.id)).limit(1);
    expect(run!.input).toEqual({ tone: "formal" });
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
