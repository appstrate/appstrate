// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test: `buildAgentPackage` emits the canonical multi-package
 * `.afps-bundle` format (Phase 3 of the bundle-format roadmap).
 *
 * Seeds an agent with a skill draft dep, drops the dep's file set into the
 * `library-packages` bucket, and asserts:
 *   - the produced ZIP is a valid multi-package bundle
 *     (`readBundleFromBuffer` accepts it)
 *   - the bundle's root is the seeded agent, with `manifest.json` +
 *     `prompt.md` at the root package
 *   - the declared skill dep is resolved and embedded under
 *     `packages/@scope/name/version/…`
 *   - the flat layout matches what the runtime resolvers expect:
 *     `skills/<scoped-id>/`.
 *
 * NOTE: skills are the only bundle dependency the platform resolves.
 * The `tool`/`provider` AFPS package types were removed, and integrations
 * are spawned as separate MCP servers at runtime (never embedded in the
 * agent bundle) — so `DraftPackageCatalog` only resolves the skill folder.
 *
 * This is the round-trip guarantee that lets the host switch to
 * multi-package without breaking the container resolvers.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { uploadPackageFiles } from "../../../src/services/package-items/storage.ts";
import { buildAgentPackage } from "../../../src/services/package-storage.ts";
import type { AgentManifest } from "../../../src/types/index.ts";
import { readBundleFromBuffer } from "@appstrate/afps-runtime/bundle";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function dec(b: Uint8Array | undefined): string {
  return b ? new TextDecoder().decode(b) : "";
}

describe("buildAgentPackage — multi-package bundle output", () => {
  let ctx: TestContext;
  let ORG_ID: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "bundlehost" });
    ORG_ID = ctx.org.id;
  });

  it("emits a valid Bundle with root + skill dep", async () => {
    // ─── 1. Seed the dep package and its draft files ─────────────────
    const skillManifest = {
      name: "@bundlehost/md-skill",
      version: "1.0.0",
      type: "skill",
      description: "Markdown skill",
    };

    await seedPackage({
      id: "@bundlehost/md-skill",
      type: "skill",
      orgId: ORG_ID,
      draftManifest: skillManifest,
    });
    await uploadPackageFiles("skills", ORG_ID, "@bundlehost/md-skill", {
      "manifest.json": enc(JSON.stringify(skillManifest, null, 2)),
      "SKILL.md": enc("---\nname: md\n---\nUse markdown."),
    });

    // ─── 2. Seed the root agent with the skill dep ───────────────────
    const agentManifest = {
      name: "@bundlehost/root-agent",
      version: "3.0.0",
      type: "agent",
      description: "Root agent",
      dependencies: {
        skills: { "@bundlehost/md-skill": "^1" },
      },
    };
    await seedPackage({
      id: "@bundlehost/root-agent",
      type: "agent",
      orgId: ORG_ID,
      draftManifest: agentManifest,
    });

    // ─── 3. buildAgentPackage — emits multi-package bundle ───────────
    const result = await buildAgentPackage(
      {
        id: "@bundlehost/root-agent",
        manifest: agentManifest as unknown as AgentManifest,
        prompt: "You are the agent.",
        skills: [],
        source: "local",
      },
      ORG_ID,
    );

    expect(result.zip.byteLength).toBeGreaterThan(0);

    // ─── 4. Read it back as a Bundle ─────────────────────────────────
    const bundle = readBundleFromBuffer(new Uint8Array(result.zip));
    expect(bundle.root).toBe("@bundlehost/root-agent@3.0.0");
    expect(bundle.packages.size).toBe(2); // agent + skill

    const rootPkg = bundle.packages.get(bundle.root)!;
    expect(dec(rootPkg.files.get("prompt.md"))).toBe("You are the agent.");
    expect(dec(rootPkg.files.get("manifest.json"))).toContain('"name": "@bundlehost/root-agent"');

    expect(bundle.packages.has("@bundlehost/md-skill@1.0.0")).toBe(true);

    // ─── 5. Assert dep package contents match the uploaded files ────
    const skillPkg = bundle.packages.get("@bundlehost/md-skill@1.0.0")!;
    expect(dec(skillPkg.files.get("SKILL.md"))).toContain("markdown");
  });

  it("always emits a non-empty root package — the invariant behind the runtime's 404=fatal workspace fetch", async () => {
    // The agent runtime treats a 404 on GET /api/runs/:runId/workspace as a
    // FATAL provisioning fault, never a legitimately-empty workspace
    // (runtime-pi/entrypoint.ts `provisionWorkspace`). That 404=fatal
    // contract is sound ONLY because this chain never produces an empty
    // upload:
    //   buildAgentPackage → always a bundle with root manifest.json +
    //   prompt.md → pi.ts pushes `agent-package.afps` into filesToInject →
    //   uploadRunWorkspace gets >=1 file → the stored object always exists.
    // If buildAgentPackage ever regressed to an empty bundle, the upload
    // would no-op, the agent's fetch would 404, and the run would fail loud
    // — re-opening the silent-degradation hole #549 closed. This test pins
    // the load-bearing end of that contract: even the barest agent (no
    // skills, no deps) yields a non-empty root package.
    const manifest = {
      name: "@bundlehost/bare-agent",
      version: "0.0.1",
      type: "agent",
      description: "No skills, no deps",
    };
    await seedPackage({
      id: "@bundlehost/bare-agent",
      type: "agent",
      orgId: ORG_ID,
      draftManifest: manifest,
    });

    const result = await buildAgentPackage(
      {
        id: "@bundlehost/bare-agent",
        manifest: manifest as unknown as AgentManifest,
        prompt: "Bare.",
        skills: [],
        source: "local",
      },
      ORG_ID,
    );

    expect(result.zip.byteLength).toBeGreaterThan(0);
    const bundle = readBundleFromBuffer(new Uint8Array(result.zip));
    expect(bundle.packages.size).toBeGreaterThanOrEqual(1);
    const rootPkg = bundle.packages.get(bundle.root)!;
    expect(rootPkg.files.has("manifest.json")).toBe(true);
    expect(rootPkg.files.has("prompt.md")).toBe(true);
  });

  it("produces a deterministic bundle — two builds yield byte-identical ZIPs", async () => {
    const manifest = {
      name: "@bundlehost/solo-agent",
      version: "1.2.3",
      type: "agent",
      description: "Standalone agent",
    };
    await seedPackage({
      id: "@bundlehost/solo-agent",
      type: "agent",
      orgId: ORG_ID,
      draftManifest: manifest,
    });

    const a = await buildAgentPackage(
      {
        id: "@bundlehost/solo-agent",
        manifest: manifest as unknown as AgentManifest,
        prompt: "Deterministic please.",
        skills: [],
        source: "local",
      },
      ORG_ID,
    );
    const b = await buildAgentPackage(
      {
        id: "@bundlehost/solo-agent",
        manifest: manifest as unknown as AgentManifest,
        prompt: "Deterministic please.",
        skills: [],
        source: "local",
      },
      ORG_ID,
    );

    expect(a.zip.equals(b.zip)).toBe(true);
  });

  it("ignores deps present in manifest but absent from DB/storage via explicit error", async () => {
    const manifest = {
      name: "@bundlehost/broken-agent",
      version: "1.0.0",
      type: "agent",
      description: "Declares a ghost dep",
      dependencies: {
        skills: { "@bundlehost/ghost": "^1" },
      },
    };
    await seedPackage({
      id: "@bundlehost/broken-agent",
      type: "agent",
      orgId: ORG_ID,
      draftManifest: manifest,
    });

    await expect(
      buildAgentPackage(
        {
          id: "@bundlehost/broken-agent",
          manifest: manifest as unknown as AgentManifest,
          prompt: "nope",
          skills: [],
          source: "local",
        },
        ORG_ID,
      ),
    ).rejects.toThrow(/unresolved dependency|ghost/i);
  });
});
