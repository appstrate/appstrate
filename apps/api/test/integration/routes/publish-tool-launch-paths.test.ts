// SPDX-License-Identifier: Apache-2.0

/**
 * `publish_file` has to reach the container on EVERY launch path, and an id
 * the platform does not know has to be refused loudly or dropped audibly —
 * never quietly mistaken for something else.
 *
 * Why this is an integration test and not a unit one: `runtime-pi/entrypoint.ts`
 * gates the publish tool on `declaredRuntimeTools.includes("publish_file")`,
 * reading `runtime_tools` straight out of the root manifest inside
 * `agent-package.afps`. Every ordinary launch — the run routes, the MCP
 * `run_and_wait` shortcut and the scheduler — reaches that manifest through
 * `run-pipeline` → `buildRunContext` → `buildAgentPackage`, and the stores
 * feeding them hand their bytes over verbatim (`package-catalog` returns
 * `packages.draft_manifest` as stored, `package-versions` returns
 * `package_versions.manifest` as stored). A regression anywhere along that
 * chain is SILENT: the agent launches, registers `log`, registers no publish
 * tool, loses everything written outside `./outputs/`, and logs nothing.
 * `packages/core` owns the pure-function assertions; only these cases prove the
 * bytes the container actually parses.
 *
 * This file used to assert a `publish_document` → `publish_file` alias (#1177).
 * That alias is gone — no manifest carries the retired spelling — so the launch
 * cases now run on the canonical id, which is what they were always really
 * about, and the first two cases pin the replacement contract: refuse it on
 * input, report the drop on read.
 */

import { describe, it, expect, beforeEach } from "bun:test";
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

describe("publish_file across every launch path", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "publish-tool-paths" });
  });

  it("refuses an unknown runtime tool id on author input", async () => {
    const create = await app.request("/api/packages/agents", {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        manifest: {
          name: "@compatorg/unknown-tool",
          version: "0.1.0",
          type: "agent",
          schema_version: "0.1",
          display_name: "Unknown Tool",
          description: "Names an id the platform does not know",
          // The retired pre-#1177 spelling. Once the alias existed this was
          // rewritten to `publish_file`; now it is simply not a valid id.
          runtime_tools: ["log", "publish_document"],
        },
        content: "Do the thing.",
      }),
    });
    // Loud on the way in — the author gets told, rather than discovering at
    // run time that a tool they selected was never registered.
    expect(create.status).toBe(400);
  });

  it("drops an unknown id from a stored published manifest, and does not guess", async () => {
    await seedPackage({ orgId: ctx.orgId, id: "@compatorg/published", type: "agent" });
    await seedInstalledPackage(ctx.defaultSpaceId, "@compatorg/published");
    // A PUBLISHED version is immutable by construction — it cannot be repaired
    // in place, so this is the strictest case for the read direction: a hard
    // enum rejection here would make the agent permanently unrunnable.
    await seedPackageVersion({
      packageId: "@compatorg/published",
      version: "1.0.0",
      manifest: {
        name: "@compatorg/published",
        version: "1.0.0",
        type: "agent",
        schema_version: "0.1",
        display_name: "Published Unknown",
        description: "Carries an id the platform no longer builds",
        runtime_tools: ["log", "publish_document"],
      },
    });

    const resolved = await resolveRegistryAgent({
      packageId: "@compatorg/published",
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      stage: "published",
      spec: "1.0.0",
    });

    const tools = (resolved.agent.manifest as { runtime_tools: string[] }).runtime_tools;
    // Dropped, not resolved to `publish_file`. The agent stays runnable and
    // keeps `log`; the unknown id is gone rather than silently reinterpreted.
    expect(tools).toEqual(["log"]);
  });

  /**
   * The shared assertion for the three real launch paths: the plan handed to
   * the sidecar and the bytes handed to the container must BOTH carry the
   * publish tool. Checking only the plan would pass while the container gate
   * — an exact string match against the bundle's own manifest — sees nothing.
   */
  async function assertPublishToolSurvivesLaunch(agent: LoadedPackage, versionLabel?: string) {
    const built = await buildRunContext({
      runId: `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      agent,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
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
      id: "@compatorg/draft-agent",
      type: "agent",
      createdBy: ctx.user.id,
      draftManifest: {
        name: "@compatorg/draft-agent",
        version: "0.1.0",
        type: "agent",
        schema_version: "0.1",
        display_name: "Draft Agent",
        description: "Draft selecting the publish tool",
        runtime_tools: ["log", "publish_file"],
      },
      draftContent: "Do the thing.",
    });
    await seedInstalledPackage(ctx.defaultSpaceId, "@compatorg/draft-agent");

    // Exactly what `routes/runs.ts` puts on the context via `c.get("package")`.
    const agent = await getPackage("@compatorg/draft-agent", ctx.orgId);
    expect(agent).not.toBeNull();

    await assertPublishToolSurvivesLaunch(agent!);
  });

  it("keeps the publish tool on the scheduler launch path (pinned published version)", async () => {
    await seedDefaultOrgModel(ctx);
    // `resolveAgentRunVersion` (shared by `scheduler.ts` and `routes/runs.ts`)
    // swaps the version manifest in wholesale, so the PINNED version's ids —
    // not the draft's — are what reach `buildRunContext`. The draft is given a
    // different tool set so this test fails if the swap silently no-ops.
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
        display_name: "Scheduled Agent",
        description: "Draft selects only note",
        runtime_tools: ["note"],
      },
      draftContent: "Do the thing.",
    });
    await seedInstalledPackage(ctx.defaultSpaceId, "@compatorg/scheduled");
    await seedPackageVersion({
      packageId: "@compatorg/scheduled",
      version: "1.0.0",
      manifest: {
        name: "@compatorg/scheduled",
        version: "1.0.0",
        type: "agent",
        schema_version: "0.1",
        display_name: "Scheduled Agent",
        description: "Published version selects the publish tool",
        runtime_tools: ["log", "publish_file"],
      },
    });

    const draftAgent = await getPackage("@compatorg/scheduled", ctx.orgId);
    const resolved = await resolveAgentRunVersion(draftAgent!, "1.0.0");

    await assertPublishToolSurvivesLaunch(resolved.agent, resolved.overrideVersionLabel);
  });

  it("keeps the publish tool on the inline / run_and_wait launch path", async () => {
    await seedDefaultOrgModel(ctx);
    // Inline has no stored package at all: `POST /api/runs/inline` — and the
    // MCP `run_and_wait` shortcut behind it — takes the manifest off the
    // REQUEST BODY on every call, so this path never benefits from anything
    // done once at save time.
    const rawManifest = {
      name: "@inline/publish-tools",
      version: "0.1.0",
      type: "agent",
      schema_version: "0.1",
      display_name: "Inline Agent",
      description: "Inline manifest selecting the publish tool",
      runtime_tools: ["log", "publish_file"],
    };
    const validated = validateInlineManifest({
      manifest: rawManifest,
      prompt: "Do the thing.",
      limits: getInlineRunLimits(),
    });
    expect(validated.valid).toBe(true);

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
