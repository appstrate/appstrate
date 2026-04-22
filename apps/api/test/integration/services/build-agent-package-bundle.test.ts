// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test: `buildAgentPackage` now emits the canonical
 * multi-package `.afps-bundle` format (Phase 3 of the bundle-format
 * roadmap).
 *
 * Seeds an agent with skill + tool + provider draft deps, drops each
 * dep's file set into the `library-packages` bucket, and asserts:
 *   - the produced ZIP is a valid multi-package bundle
 *     (`readBundleFromBuffer` accepts it)
 *   - the bundle's root is the seeded agent, with `manifest.json` +
 *     `prompt.md` at the root package
 *   - each declared dep is resolved and embedded under
 *     `packages/@scope/name/version/…`
 *   - `toolDocs` preserves the legacy contract: one entry per
 *     tool dep that ships a `TOOL.md`
 *   - when projected back through `bundleToLoadedBundle` (what the
 *     container does), the flat layout matches what the runtime
 *     resolvers expect: `tools/<scoped-id>/`, `skills/<scoped-id>/`,
 *     `providers/<scoped-id>/`.
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
import { bundleToLoadedBundle, readBundleFromBuffer } from "@appstrate/afps-runtime/bundle";

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

  it("emits a valid Bundle with root + skill + tool + provider deps", async () => {
    // ─── 1. Seed the dep packages and their draft files ──────────────
    const skillManifest = {
      name: "@bundlehost/md-skill",
      version: "1.0.0",
      type: "skill",
      description: "Markdown skill",
    };
    const toolManifest = {
      name: "@bundlehost/calc-tool",
      version: "2.1.0",
      type: "tool",
      description: "Calc tool",
    };
    const providerManifest = {
      name: "@bundlehost/svc-provider",
      version: "0.5.0",
      type: "provider",
      description: "Svc provider",
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

    await seedPackage({
      id: "@bundlehost/calc-tool",
      type: "tool",
      orgId: ORG_ID,
      draftManifest: toolManifest,
    });
    await uploadPackageFiles("tools", ORG_ID, "@bundlehost/calc-tool", {
      "manifest.json": enc(JSON.stringify(toolManifest, null, 2)),
      "TOOL.md": enc("Calculator tool documentation"),
      "index.ts": enc("export default () => ({ name: 'calc' });"),
    });

    await seedPackage({
      id: "@bundlehost/svc-provider",
      type: "provider",
      orgId: ORG_ID,
      draftManifest: providerManifest,
    });
    await uploadPackageFiles("providers", ORG_ID, "@bundlehost/svc-provider", {
      "manifest.json": enc(JSON.stringify(providerManifest, null, 2)),
      "PROVIDER.md": enc("Provider doc"),
    });

    // ─── 2. Seed the root agent with all three deps ──────────────────
    const agentManifest = {
      name: "@bundlehost/root-agent",
      version: "3.0.0",
      type: "agent",
      description: "Root agent",
      dependencies: {
        skills: { "@bundlehost/md-skill": "^1" },
        tools: { "@bundlehost/calc-tool": "^2" },
        providers: { "@bundlehost/svc-provider": "^0.5" },
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
        tools: [],
        source: "local",
      },
      ORG_ID,
    );

    expect(result.zip.byteLength).toBeGreaterThan(0);
    expect(result.toolDocs).toEqual([
      { id: "@bundlehost/calc-tool", content: "Calculator tool documentation" },
    ]);

    // ─── 4. Read it back as a Bundle ─────────────────────────────────
    const bundle = readBundleFromBuffer(new Uint8Array(result.zip));
    expect(bundle.root).toBe("@bundlehost/root-agent@3.0.0");
    expect(bundle.packages.size).toBe(4); // agent + 3 deps

    const rootPkg = bundle.packages.get(bundle.root)!;
    expect(dec(rootPkg.files.get("prompt.md"))).toBe("You are the agent.");
    expect(dec(rootPkg.files.get("manifest.json"))).toContain('"name": "@bundlehost/root-agent"');

    expect(bundle.packages.has("@bundlehost/md-skill@1.0.0")).toBe(true);
    expect(bundle.packages.has("@bundlehost/calc-tool@2.1.0")).toBe(true);
    expect(bundle.packages.has("@bundlehost/svc-provider@0.5.0")).toBe(true);

    // ─── 5. Project back through the adapter — the shape the runtime ─
    //       resolvers + entrypoint expect.
    const loaded = bundleToLoadedBundle(bundle);
    expect(loaded.prompt).toBe("You are the agent.");
    expect(dec(loaded.files["skills/@bundlehost/md-skill/SKILL.md"])).toContain("markdown");
    expect(dec(loaded.files["tools/@bundlehost/calc-tool/TOOL.md"])).toBe(
      "Calculator tool documentation",
    );
    expect(dec(loaded.files["tools/@bundlehost/calc-tool/index.ts"])).toContain("export default");
    expect(dec(loaded.files["providers/@bundlehost/svc-provider/PROVIDER.md"])).toBe(
      "Provider doc",
    );
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
        tools: [],
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
        tools: [],
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
        tools: { "@bundlehost/ghost": "^1" },
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
          tools: [],
          source: "local",
        },
        ORG_ID,
      ),
    ).rejects.toThrow(/unresolved dependency|ghost/i);
  });
});
