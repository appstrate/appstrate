// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #1177 — the compatibility surface of the `document` → `file` rename.
 *
 * Every case here is a SILENT failure if it regresses: none of them throws, and
 * none of them shows up in a log. They are grouped in one file so the whole
 * "what still has to keep working after the rename" contract is readable at
 * once, rather than scattered across the suites of the things it constrains.
 *
 * The five callers that outlive a platform deploy:
 *
 *   1. a runtime-pi image older than the platform (the two deploy separately) —
 *      posts `X-Document-Name`, emits `document.published` with a `document_id`,
 *      and calls `/api/runs/:id/documents`;
 *   2. a pinned SPA build, the CLI, an MCP client and third-party integrations —
 *      call `/api/documents/*`;
 *   3. a caller of `POST /api/runs/inline` that still sends `context_documents`;
 *   4. run rows written before the rename — `runs.input` full of `document://`
 *      URIs and `run_logs` rows tagged `event: "document"`;
 *   5. agent manifests published before the rename — `runtime_tools:
 *      ["publish_document"]`. Asserted on the paths a real agent launches
 *      on (the run routes and the scheduler, both via `buildRunContext`), not
 *      only on `POST /api/runs/remote`: the remote resolver was the one place
 *      that already canonicalized, so covering only it hid the gap.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs, files, runLogs, packages } from "@appstrate/db/schema";
import { encrypt } from "@appstrate/connect";
import { sign } from "@appstrate/afps-runtime/events";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageVersion, seedInstalledPackage } from "../../helpers/seed.ts";
import { resolveRegistryAgent } from "../../../src/services/registry-run-resolver.ts";
import { resolveAgentRunVersion } from "../../../src/services/agent-version-resolver.ts";
import { buildRunContext } from "../../../src/services/run-context-builder.ts";
import { getPackage } from "../../../src/services/package-catalog.ts";
import { createFileFromStream } from "../../../src/services/files.ts";
import { getRunFull } from "../../../src/services/state/runs.ts";
import { seedDefaultOrgModel } from "../../helpers/run-connection-fixtures.ts";
import { readBundleFromBuffer } from "@appstrate/afps-runtime/bundle";
import type { LoadedPackage } from "../../../src/types/index.ts";

const app = getTestApp();

const RUN_SECRET = "a".repeat(43); // matches mintSinkCredentials base64url(32 bytes)

function signedHeaders(body: string): Record<string, string> {
  const msgId = `msg_${crypto.randomUUID()}`;
  const timestampSec = Math.floor(Date.now() / 1000);
  return { ...sign({ msgId, timestampSec, body, secret: RUN_SECRET }) };
}

async function seedRunWithSink(ctx: TestContext, packageId?: string): Promise<string> {
  const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(runs).values({
    id: runId,
    ...(packageId ? { packageId } : {}),
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    status: "running",
    runOrigin: "platform",
    sinkSecretEncrypted: encrypt(RUN_SECRET),
    sinkExpiresAt: new Date(Date.now() + 3600_000),
    startedAt: new Date(),
    tokenUsage: { input_tokens: 10, output_tokens: 5 },
  });
  return runId;
}

/** Publish a file onto a run through the service, bypassing the HTTP route. */
async function publishFile(ctx: TestContext, runId: string, name: string, body: string) {
  const { row } = await createFileFromStream(
    { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
    runId,
    { userId: ctx.user.id, endUserId: null },
    null,
    { name, mime: "text/plain", body: new Response(body).body! },
  );
  return row;
}

describe("#1177 compatibility — an older runtime image", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "compat-runtime" });
  });

  it("publishes with the retired X-Document-Name header", async () => {
    const runId = await seedRunWithSink(ctx);
    const res = await app.request(`/api/runs/${runId}/files`, {
      method: "POST",
      headers: {
        ...signedHeaders(""),
        // The pre-#1177 spelling — the ONLY name header an older image sends.
        "X-Document-Name": "rapport-trimestriel.md",
        "Content-Type": "text/markdown",
      },
      body: "# rapport",
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string };
    expect(body.name).toBe("rapport-trimestriel.md");
    const [row] = await db.select().from(files).where(eq(files.id, body.id));
    expect(row!.name).toBe("rapport-trimestriel.md");
  });

  it("lets X-File-Name win when an image sends both headers", async () => {
    const runId = await seedRunWithSink(ctx);
    const res = await app.request(`/api/runs/${runId}/files`, {
      method: "POST",
      headers: {
        ...signedHeaders(""),
        "X-File-Name": "canonical.txt",
        "X-Document-Name": "legacy.txt",
        "Content-Type": "text/plain",
      },
      body: "bytes",
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { name: string }).name).toBe("canonical.txt");
  });

  it("publishes through the retired POST /api/runs/:id/documents path", async () => {
    const runId = await seedRunWithSink(ctx);
    const res = await app.request(`/api/runs/${runId}/documents`, {
      method: "POST",
      headers: {
        ...signedHeaders(""),
        "X-Document-Name": "old-path.txt",
        "Content-Type": "text/plain",
      },
      body: "old-path bytes",
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { name: string }).name).toBe("old-path.txt");
  });

  it("serves the input-file manifest under both keys and both paths", async () => {
    const runId = await seedRunWithSink(ctx);
    // No workspace provisioned → 404 on both spellings, which the runtime reads
    // as "this run carries no input files". What matters here is that the
    // retired path is ROUTED (a 404 from the handler, not from the router's
    // unknown-API catch-all, which answers with a different problem code).
    for (const path of [`/api/runs/${runId}/files`, `/api/runs/${runId}/documents`]) {
      const res = await app.request(path, { method: "GET", headers: signedHeaders("") });
      expect(res.status).toBe(404);
      const problem = (await res.json()) as { detail?: string };
      expect(problem.detail).toContain("no input files");
    }
  });

  it("ingests a retired document.published event carrying a document_id", async () => {
    await seedPackage({ orgId: ctx.orgId, id: "@test/compat-agent", type: "agent" });
    const runId = await seedRunWithSink(ctx, "@test/compat-agent");
    const row = await publishFile(ctx, runId, "deliverable.txt", "bytes");

    const envelope = {
      specversion: "1.0",
      type: "document.published",
      source: `/afps/runs/${runId}`,
      id: `msg_${crypto.randomUUID()}`,
      time: new Date().toISOString(),
      datacontenttype: "application/json",
      // The pre-#1177 payload key.
      data: { document_id: row.id, name: row.name, mime: row.mime, size: row.size },
      sequence: 1,
    };
    const body = JSON.stringify(envelope);
    const res = await app.request(`/api/runs/${runId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signedHeaders(body) },
      body,
    });
    expect(res.status).toBe(200);

    // The run log is the whole point: without it the file is stored but never
    // appears in the run's timeline, and nothing reports the loss.
    const logs = await db.select().from(runLogs).where(eq(runLogs.runId, runId));
    const published = logs.find((l) => l.event === "file");
    expect(published).toBeDefined();
    expect((published!.data as Record<string, unknown>).file_id).toBe(row.id);
    expect((published!.data as Record<string, unknown>).uri).toBe(`appfile://${row.id}`);
  });
});

describe("#1177 compatibility — the deprecated /api/documents aliases", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "compat-http" });
  });

  it("serves list, get, content and keep on the retired paths", async () => {
    const runId = await seedRunWithSink(ctx);
    const row = await publishFile(ctx, runId, "alias.txt", "alias bytes");

    const list = await app.request("/api/documents", { headers: authHeaders(ctx) });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { data: { id: string }[] }).data.map((d) => d.id)).toContain(
      row.id,
    );

    const one = await app.request(`/api/documents/${row.id}`, { headers: authHeaders(ctx) });
    expect(one.status).toBe(200);
    // The DTO is byte-identical to the canonical path's — same handler.
    const canonical = await app.request(`/api/files/${row.id}`, { headers: authHeaders(ctx) });
    const [aliasDto, canonicalDto] = (await Promise.all([one.json(), canonical.json()])) as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    // `preview_url` carries a freshly minted token per request, so compare the
    // rest of the DTO.
    delete aliasDto.preview_url;
    delete canonicalDto.preview_url;
    expect(aliasDto).toEqual(canonicalDto);

    const content = await app.request(`/api/documents/${row.id}/content`, {
      headers: authHeaders(ctx),
    });
    expect(content.status).toBe(200);
    expect(await content.text()).toBe("alias bytes");

    const keep = await app.request(`/api/documents/${row.id}/keep`, {
      method: "POST",
      headers: authHeaders(ctx),
    });
    expect(keep.status).toBe(200);
  });

  it("deletes on the retired path", async () => {
    const runId = await seedRunWithSink(ctx);
    const row = await publishFile(ctx, runId, "gone.txt", "bytes");
    const res = await app.request(`/api/documents/${row.id}`, {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(204);
    expect(await db.select().from(files).where(eq(files.id, row.id))).toHaveLength(0);
  });

  it("serves the hardened preview on the retired /preview/documents path", async () => {
    const runId = await seedRunWithSink(ctx);
    const row = await publishFile(ctx, runId, "note.txt", "preview bytes");
    const dto = (await (
      await app.request(`/api/files/${row.id}`, { headers: authHeaders(ctx) })
    ).json()) as { preview_url: string | null };
    expect(dto.preview_url).toBeTruthy();

    const legacyUrl = new URL(dto.preview_url!);
    const res = await app.request(
      `/preview/documents/${row.id}${legacyUrl.search}`,
      // Cookie-less by design — the signed token IS the authorization.
      { headers: {} },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("preview bytes");
  });
});

describe("#1177 compatibility — persisted run data", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "compat-data" });
  });

  it("keeps counting a historical document:// URI in runs.input", async () => {
    const runId = await seedRunWithSink(ctx);
    const row = await publishFile(ctx, runId, "input.txt", "bytes");

    // A run row written before #1177: its input references the file under the
    // retired scheme. `extractFileIds` (core) must still find it, otherwise the
    // run's file counts silently read zero and the gallery's `run_id` filter
    // stops returning the run's inputs.
    const consumerId = await seedRunWithSink(ctx);
    await db
      .update(runs)
      .set({ input: { attachment: `document://${row.id}` } })
      .where(eq(runs.id, consumerId));

    const full = await getRunFull(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      consumerId,
    );
    expect(full!.file_counts).toEqual({ input: 1, output: 0 });
  });

  it("serves a historical run log tagged event: document unchanged", async () => {
    const runId = await seedRunWithSink(ctx);
    const row = await publishFile(ctx, runId, "old-log.txt", "bytes");
    await db.insert(runLogs).values({
      runId,
      orgId: ctx.orgId,
      type: "result",
      // The pre-#1177 tag, with the pre-#1177 payload key.
      event: "document",
      level: "info",
      data: { document_id: row.id, uri: `document://${row.id}`, name: row.name },
    });

    const res = await app.request(`/api/runs/${runId}/logs`, { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { event: string; data: unknown }[] };
    const legacy = body.data.find((l) => l.event === "document");
    expect(legacy).toBeDefined();
    // Served VERBATIM — the platform never rewrites history, the readers accept
    // both spellings (see `PUBLISHED_FILE_LOG_EVENTS` in the chat module and
    // `run-detail.tsx`).
    expect((legacy!.data as Record<string, unknown>).document_id).toBe(row.id);
  });
});

describe("#1177 compatibility — the inline launch body", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "compat-inline" });
  });

  /**
   * The body schema is `.strict()`. An undeclared field is a 400 and a field
   * read but not declared is stripped before the handler sees it — #1189 is the
   * repo's own scar from exactly that: a launch-body field no surface
   * allowlisted was dropped in silence and the model looped with no error.
   */
  it("accepts the retired context_documents argument", async () => {
    const runId = await seedRunWithSink(ctx);
    const row = await publishFile(ctx, runId, "chained.txt", "chained bytes");

    const res = await app.request("/api/runs/inline/validate", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest: {
          name: "@inline/compat",
          display_name: "Compat",
          version: "0.0.0",
          type: "agent",
          description: "Compat run",
          schema_version: "0.1",
          dependencies: { skills: {} },
        },
        prompt: "read the file",
        context_documents: [`document://${row.id}`],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: true });
  });

  it("rejects a malformed retired context_documents entry the same way", async () => {
    const res = await app.request("/api/runs/inline/validate", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest: {
          name: "@inline/compat",
          display_name: "Compat",
          version: "0.0.0",
          type: "agent",
          description: "Compat run",
          schema_version: "0.1",
          dependencies: { skills: {} },
        },
        prompt: "read the file",
        context_documents: ["not-a-uri"],
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("#1177 compatibility — a manifest that names publish_document", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "compat-manifest" });
  });

  /**
   * `dropRetiredRuntimeTools()` keeps only ids that pass
   * `isSelectableRuntimeTool` and SILENTLY DELETES the rest, so a bare rename
   * would not error — it would strip the publish tool and the agent would stop
   * producing files with nothing in any log. `packages/core` owns the unit
   * assertions; these two are the same claim through the HTTP write path and
   * through the run-launch read path, which are the two places a real agent
   * meets the alias.
   */
  it("normalizes publish_document to publish_file on save, and serves it back", async () => {
    const create = await app.request("/api/packages/agents", {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        manifest: {
          name: "@compatorg/legacy-tools",
          version: "0.1.0",
          type: "agent",
          schema_version: "0.1",
          display_name: "Legacy Tools",
          description: "Names the retired publish tool id",
          // The pre-#1177 id, exactly as it sits in a manifest authored before
          // the rename (or exported from one).
          runtime_tools: ["log", "publish_document"],
        },
        content: "Do the thing.",
      }),
    });
    expect(create.status).toBe(201);

    const [row] = await db
      .select({ manifest: packages.draftManifest })
      .from(packages)
      .where(eq(packages.id, "@compatorg/legacy-tools"));
    // Written canonical — the legacy spelling never reaches storage again.
    expect((row!.manifest as { runtime_tools: string[] }).runtime_tools).toEqual([
      "log",
      "publish_file",
    ]);
  });

  it("keeps the publish tool when a run resolves a stored publish_document", async () => {
    await seedPackage({ orgId: ctx.orgId, id: "@compatorg/published", type: "agent" });
    await seedInstalledPackage(ctx.defaultAppId, "@compatorg/published");
    // A PUBLISHED version is immutable by construction — it cannot be repaired
    // in place, so this is the strictest case for the read-direction alias.
    await seedPackageVersion({
      packageId: "@compatorg/published",
      version: "1.0.0",
      manifest: {
        name: "@compatorg/published",
        version: "1.0.0",
        type: "agent",
        schema_version: "0.1",
        display_name: "Published Legacy",
        description: "Published before #1177",
        runtime_tools: ["log", "publish_document"],
      },
    });

    const resolved = await resolveRegistryAgent({
      packageId: "@compatorg/published",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      stage: "published",
      spec: "1.0.0",
    });

    const tools = (resolved.agent.manifest as { runtime_tools: string[] }).runtime_tools;
    // Normalized, not dropped, and not duplicated.
    expect(tools).toEqual(["log", "publish_file"]);
  });

  /**
   * The two cases above cover the WRITE path and `POST /api/runs/remote`.
   * Neither is how a real agent launches.
   *
   * `runtime-pi/entrypoint.ts` gates the publish tool on
   * `declaredRuntimeTools.includes("publish_file")`, reading `runtime_tools`
   * straight out of the root manifest inside `agent-package.afps`. Every
   * ordinary launch — the run routes, the MCP `run_and_wait` shortcut and the
   * scheduler — reaches that manifest through
   * `run-pipeline` → `buildRunContext` → `buildAgentPackage`, and none of those
   * used to canonicalize: `package-catalog` returns `packages.draft_manifest`
   * as stored and `package-versions` returns `package_versions.manifest` as
   * stored. An agent published as `["log", "publish_document"]` therefore
   * launched fine, registered `log`, registered NO publish tool, lost
   * everything written outside `./outputs/`, and logged nothing.
   *
   * So these two assert the alias where it actually has to hold: on the bytes
   * the container parses, plus the plan the platform hands the sidecar.
   */
  async function assertPublishToolSurvivesLaunch(agent: LoadedPackage, versionLabel?: string) {
    const built = await buildRunContext({
      runId: `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      agent,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      input: {},
      ...(versionLabel ? { overrideVersionLabel: versionLabel } : {}),
    });

    // 1. What the sidecar is told (RUNTIME_TOOLS_JSON is serialized from this).
    expect(built.plan.runtimeTools).toEqual(["log", "publish_file"]);

    // 2. What the CONTAINER reads — the root manifest inside the bundle ZIP.
    //    This is the exact byte stream `readBundleFromFile` parses in
    //    `runtime-pi/entrypoint.ts` before the `publish_file` gate.
    expect(built.agentPackage).not.toBeNull();
    const bundle = readBundleFromBuffer(built.agentPackage!);
    const rootManifest = bundle.packages.get(bundle.root)!.manifest as {
      runtime_tools: string[];
    };
    expect(rootManifest.runtime_tools).toEqual(["log", "publish_file"]);
  }

  it("keeps the publish tool on the normal agent-run launch path (stored draft)", async () => {
    await seedDefaultOrgModel(ctx);
    await seedPackage({
      orgId: ctx.orgId,
      id: "@compatorg/draft-legacy",
      type: "agent",
      createdBy: ctx.user.id,
      draftManifest: {
        name: "@compatorg/draft-legacy",
        version: "0.1.0",
        type: "agent",
        schema_version: "0.1",
        display_name: "Draft Legacy",
        description: "Draft persisted before #1177",
        runtime_tools: ["log", "publish_document"],
      },
      draftContent: "Do the thing.",
    });
    await seedInstalledPackage(ctx.defaultAppId, "@compatorg/draft-legacy");

    // Exactly what `routes/runs.ts` puts on the context via `c.get("package")`.
    const agent = await getPackage("@compatorg/draft-legacy", ctx.orgId);
    expect(agent).not.toBeNull();
    // Pre-condition: the stored bytes are still the legacy spelling. If this
    // ever stops holding, the assertions below stop proving anything.
    expect((agent!.manifest as { runtime_tools: string[] }).runtime_tools).toEqual([
      "log",
      "publish_document",
    ]);

    await assertPublishToolSurvivesLaunch(agent!);
  });

  it("keeps the publish tool on the scheduler launch path (pinned published version)", async () => {
    await seedDefaultOrgModel(ctx);
    // The schedule's own agent row is post-rename and clean; the PUBLISHED
    // version it pins is the pre-rename one. `resolveAgentRunVersion` (shared
    // by `scheduler.ts` and `routes/runs.ts`) swaps the version manifest in
    // wholesale, so the legacy ids reach `buildRunContext` untouched.
    await seedPackage({
      orgId: ctx.orgId,
      id: "@compatorg/scheduled",
      type: "agent",
      createdBy: ctx.user.id,
      draftManifest: {
        name: "@compatorg/scheduled",
        version: "1.0.0",
        type: "agent",
        schema_version: "0.1",
        display_name: "Scheduled Legacy",
        description: "Draft is clean",
        runtime_tools: ["log", "publish_file"],
      },
      draftContent: "Do the thing.",
    });
    await seedInstalledPackage(ctx.defaultAppId, "@compatorg/scheduled");
    await seedPackageVersion({
      packageId: "@compatorg/scheduled",
      version: "1.0.0",
      manifest: {
        name: "@compatorg/scheduled",
        version: "1.0.0",
        type: "agent",
        schema_version: "0.1",
        display_name: "Scheduled Legacy",
        description: "Published before #1177",
        runtime_tools: ["log", "publish_document"],
      },
    });

    const draftAgent = await getPackage("@compatorg/scheduled", ctx.orgId);
    const resolved = await resolveAgentRunVersion(draftAgent!, "1.0.0");
    expect((resolved.agent.manifest as { runtime_tools: string[] }).runtime_tools).toEqual([
      "log",
      "publish_document",
    ]);

    await assertPublishToolSurvivesLaunch(resolved.agent, resolved.overrideVersionLabel);
  });
});
