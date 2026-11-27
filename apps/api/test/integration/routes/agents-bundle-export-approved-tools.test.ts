// SPDX-License-Identifier: Apache-2.0
/**
 * `Appstrate-Space-Approved-Tools` on `GET /api/agents/:scope/:name/bundle`: the tools the exported
 * agent selects that run in the space only because the space approved their definition.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync } from "fflate";
import { db } from "@appstrate/db/client";
import { packageDistTags } from "@appstrate/db/schema";
import * as storage from "@appstrate/db/storage";
import { computeIntegrity } from "@appstrate/core/integrity";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import { insertToolApprovals, tool, toolFingerprint } from "../../helpers/tool-policy.ts";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { remoteIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { activatePackage } from "../../../src/services/space-packages.ts";
import { recordToolSnapshot } from "../../../src/services/integration-tool-snapshots.ts";
import { AGENT_PACKAGES_BUCKET, versionZipKey } from "../../../src/services/package-storage.ts";

const AGENT = "@acme/exporter" as const;
const INTEG = "@acme/files" as const;
const HEADER = "Appstrate-Space-Approved-Tools";
const app = getTestApp();
const enc = (s: string) => new TextEncoder().encode(s);

async function publish(
  id: `@${string}/${string}`,
  type: "agent" | "integration",
  ctx: TestContext,
  manifest: Record<string, unknown>,
) {
  await seedPackage({ id, type, orgId: ctx.orgId, homeSpaceId: ctx.defaultSpaceId });
  const afps = zipSync({
    "manifest.json": enc(JSON.stringify(manifest)),
    [type === "agent" ? "prompt.md" : "INTEGRATION.md"]: enc("content"),
  });
  await storage.uploadFile(AGENT_PACKAGES_BUCKET, versionZipKey(id, "1.0.0"), Buffer.from(afps));
  const pv = await seedPackageVersion({
    packageId: id,
    version: "1.0.0",
    integrity: computeIntegrity(afps),
    artifactSize: afps.length,
    manifest,
  });
  await db.insert(packageDistTags).values({ packageId: id, tag: "latest", versionId: pv.id });
  await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, id);
}

describe("bundle export: space-approved tools header", () => {
  let ctx: TestContext;

  const exportBundle = (selected: string[] | "*") => async () => {
    await publish(AGENT, "agent", ctx, {
      name: AGENT,
      version: "1.0.0",
      type: "agent",
      schema_version: "0.1",
      display_name: "Exporter",
      author: "tester",
      dependencies: { integrations: { [INTEG]: "^1.0.0" } },
      integrations_configuration: { [INTEG]: { tools: selected } },
    });
    return app.request(`/api/agents/${AGENT}/bundle`, { headers: authHeaders(ctx) });
  };

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "acme" });
    await publish(
      INTEG,
      "integration",
      ctx,
      remoteIntegrationManifest({
        name: INTEG,
        url: "https://mcp.example.com/mcp",
        tools_policy: { read_file: {} },
      }) as unknown as Record<string, unknown>,
    );
    await recordToolSnapshot({
      orgId: ctx.orgId,
      packageId: INTEG,
      connectionId: null,
      tools: [tool("read_file"), tool("write_file")],
      truncated: false,
    });
  });

  const selections: { title: string; selected: string[] | "*" }[] = [
    {
      title: "names the selected tools that run here only by the space's approval",
      selected: ["read_file", "write_file"],
    },
    {
      title: "names every approved tool when the agent selects the wildcard of a closed catalog",
      selected: "*",
    },
  ];
  for (const c of selections) {
    it(c.title, async () => {
      await insertToolApprovals({ ...ctx, spaceId: ctx.defaultSpaceId, packageId: INTEG }, [
        { toolName: "write_file", fingerprint: toolFingerprint("write_file") },
      ]);
      const res = await exportBundle(c.selected)();
      expect(res.status, await res.clone().text()).toBe(200);
      expect(res.headers.get(HEADER)).toBe(encodeURIComponent(`${INTEG}:write_file`));
    });
  }

  it("percent-encodes each element, so a tool name with a comma or a non-ASCII character survives", async () => {
    const odd = "écrire,fichier";
    await insertToolApprovals({ ...ctx, spaceId: ctx.defaultSpaceId, packageId: INTEG }, [
      { toolName: "write_file", fingerprint: toolFingerprint("write_file") },
      { toolName: odd, fingerprint: toolFingerprint(odd) },
    ]);
    const res = await exportBundle(["write_file", odd])();
    expect(res.status, await res.clone().text()).toBe(200);
    const elements = res.headers.get(HEADER)!.split(",");
    expect(elements.map((e) => decodeURIComponent(e)).sort()).toEqual(
      [`${INTEG}:write_file`, `${INTEG}:${odd}`].sort(),
    );
    expect(elements).toHaveLength(2);
  });

  it("sets no header when nothing selected depends on an approval", async () => {
    const res = await exportBundle(["read_file"])();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(res.headers.has(HEADER)).toBe(false);
  });
});
