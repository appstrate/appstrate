// SPDX-License-Identifier: Apache-2.0

/**
 * The `publish_document` → `publish_file` runtime-tool alias (issue #1177).
 *
 * The rename retired a lot of vocabulary, and most of the compatibility
 * surface went with it. This one did NOT: `publish_document` is still accepted
 * on input — `dropRetiredRuntimeTools` canonicalizes it
 * (`packages/core/src/runtime-tools-catalog.ts` holds the mapping) and the
 * OpenAPI schema still documents it on the `runtime_tools` enum — because a
 * manifest PUBLISHED before the rename is immutable and cannot be repaired in
 * place.
 *
 * Every case here is a SILENT failure if it regresses. `dropRetiredRuntimeTools`
 * keeps only ids that pass `isSelectableRuntimeTool` and DELETES the rest
 * without erroring, so losing the alias does not throw and does not log: as
 * `apps/api/src/services/package-storage.ts` puts it, an agent published under
 * the retired spelling "would launch normally and register no publish tool at
 * all … and nothing errors anywhere".
 *
 * `packages/core` owns the pure-function assertions on the mapping itself.
 * They are not enough on their own — the alias has to hold on the paths a real
 * agent launches on, and those read `packages.draft_manifest` /
 * `package_versions.manifest` AS STORED. So the cases below walk the write
 * path, the published read path, and all three launch paths (run route,
 * scheduler, inline / `run_and_wait`) end to end.
 *
 * These five cases were carried over verbatim from
 * `test/integration/routes/files-legacy-compat.test.ts`, which was deleted
 * whole when the rest of the #1177 compatibility surface was removed. The
 * aliases the other blocks covered are gone; this one is not.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages } from "@appstrate/db/schema";
import { readBundleFromBuffer } from "@appstrate/afps-runtime/bundle";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageVersion, seedInstalledPackage } from "../../helpers/seed.ts";
import { seedDefaultOrgModel } from "../../helpers/run-connection-fixtures.ts";
import { resolveRegistryAgent } from "../../../src/services/registry-run-resolver.ts";
import { resolveAgentRunVersion } from "../../../src/services/agent-version-resolver.ts";
import { buildRunContext } from "../../../src/services/run-context-builder.ts";
import { getPackage } from "../../../src/services/package-catalog.ts";
import { validateInlineManifest } from "../../../src/services/inline-manifest-validation.ts";
import { getInlineRunLimits } from "../../../src/services/run-limits.ts";
import { insertShadowPackage, buildShadowLoadedPackage } from "../../../src/services/inline-run.ts";
import type { LoadedPackage, AgentManifest } from "../../../src/types/index.ts";

const app = getTestApp();

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

  it("keeps the publish tool on the inline / run_and_wait launch path", async () => {
    await seedDefaultOrgModel(ctx);
    // Inline has no stored package to repair: `POST /api/runs/inline` — and the
    // MCP `run_and_wait` shortcut behind it — takes the manifest off the
    // REQUEST BODY on every call. A caller pinned to the pre-#1177 vocabulary
    // (a saved curl, a CI job, a model that learned the old id) keeps sending
    // `publish_document` forever, so this path has to canonicalize on each
    // request rather than once at save time.
    const rawManifest = {
      name: "@inline/legacy-tools",
      version: "0.1.0",
      type: "agent",
      schema_version: "0.1",
      display_name: "Inline Legacy",
      description: "Inline manifest authored before #1177",
      runtime_tools: ["log", "publish_document"],
    };
    const validated = validateInlineManifest({
      manifest: rawManifest,
      prompt: "Do the thing.",
      limits: getInlineRunLimits(),
    });
    expect(validated.valid).toBe(true);
    // Pre-condition, mirroring the stored cases: the bytes the caller sent
    // still carry the legacy spelling.
    expect(rawManifest.runtime_tools).toEqual(["log", "publish_document"]);

    // From here on this is verbatim what `runInlineAgent` does: mint the
    // ephemeral shadow row from the validated manifest, wrap it as the
    // `LoadedPackage` the pipeline receives, and launch.
    const manifest = validated.manifest as AgentManifest;
    const shadowId = await insertShadowPackage({
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      manifest,
      prompt: "Do the thing.",
    });
    const shadowAgent = buildShadowLoadedPackage(shadowId, manifest, "Do the thing.");

    await assertPublishToolSurvivesLaunch(shadowAgent);
  });
});
