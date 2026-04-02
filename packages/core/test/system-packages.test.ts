// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSystemPackages } from "../src/system-packages.ts";
import { zipArtifact } from "../src/zip.ts";

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makeZip(entries: Record<string, string>): Uint8Array {
  const encoded: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(entries)) {
    encoded[k] = new TextEncoder().encode(v);
  }
  return zipArtifact(encoded);
}

function providerManifest(name: string, version = "1.0.0") {
  return JSON.stringify({
    name,
    version,
    type: "provider",
    definition: {
      authMode: "oauth2",
      oauth2: {
        authorizationUrl: "https://example.com/authorize",
        tokenUrl: "https://example.com/token",
      },
    },
  });
}

function agentManifest(name: string, version = "1.0.0") {
  return JSON.stringify({
    name,
    version,
    type: "agent",
    schemaVersion: "1.0",
    displayName: "Test Agent",
    author: "test",
  });
}

function skillManifest(name: string, version = "1.0.0") {
  return JSON.stringify({
    name,
    version,
    type: "skill",
  });
}

function toolManifest(name: string, version = "1.0.0") {
  return JSON.stringify({
    name,
    version,
    type: "tool",
    entrypoint: "index.ts",
    tool: {
      name: "my-tool",
      description: "A test tool",
      inputSchema: { type: "object" },
    },
  });
}

const validToolSource = `
export default function(pi) {
  pi.registerTool({
    name: "tool",
    execute(_id, params, signal) {
      return { content: [{ type: "text", text: "ok" }] };
    }
  });
}`;

const validSkillContent = `---
name: test-skill
description: A test skill
---
# Skill content`;

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "sys-pkg-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────
// loadSystemPackages
// ─────────────────────────────────────────────

describe("loadSystemPackages", () => {
  test("loads provider ZIPs", async () => {
    const zip = makeZip({ "manifest.json": providerManifest("@test/gmail") });
    await writeFile(join(testDir, "gmail-1.0.0.afps"), zip);

    const result = await loadSystemPackages(testDir);
    expect(result.packages).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);

    const entry = result.packages[0]!;
    expect(entry.packageId).toBe("@test/gmail");
    expect(entry.scope).toBe("@test");
    expect(entry.name).toBe("gmail");
    expect(entry.type).toBe("provider");
    expect(entry.version).toBe("1.0.0");
  });

  test("loads agent ZIPs", async () => {
    const zip = makeZip({
      "manifest.json": agentManifest("@test/my-agent"),
      "prompt.md": "# Test prompt",
    });
    await writeFile(join(testDir, "my-agent-1.0.0.afps"), zip);

    const result = await loadSystemPackages(testDir);
    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]!.type).toBe("agent");
  });

  test("loads skill ZIPs", async () => {
    const zip = makeZip({
      "manifest.json": skillManifest("@test/my-skill"),
      "SKILL.md": validSkillContent,
    });
    await writeFile(join(testDir, "my-skill-1.0.0.afps"), zip);

    const result = await loadSystemPackages(testDir);
    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]!.type).toBe("skill");
  });

  test("loads tool ZIPs", async () => {
    const zip = makeZip({
      "manifest.json": toolManifest("@test/my-tool"),
      "index.ts": validToolSource,
    });
    await writeFile(join(testDir, "my-tool-1.0.0.afps"), zip);

    const result = await loadSystemPackages(testDir);
    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]!.type).toBe("tool");
  });

  test("loads multiple ZIPs", async () => {
    const zip1 = makeZip({ "manifest.json": providerManifest("@test/gmail") });
    const zip2 = makeZip({ "manifest.json": providerManifest("@test/slack") });
    await writeFile(join(testDir, "gmail-1.0.0.afps"), zip1);
    await writeFile(join(testDir, "slack-1.0.0.afps"), zip2);

    const result = await loadSystemPackages(testDir);
    expect(result.packages).toHaveLength(2);
    expect(result.warnings).toHaveLength(0);
  });

  test("skips non-zip files", async () => {
    const zip = makeZip({ "manifest.json": providerManifest("@test/gmail") });
    await writeFile(join(testDir, "gmail-1.0.0.afps"), zip);
    await writeFile(join(testDir, "readme.txt"), "not a zip");
    await writeFile(join(testDir, ".DS_Store"), "");

    const result = await loadSystemPackages(testDir);
    expect(result.packages).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });

  test("reports invalid ZIPs as warnings", async () => {
    await writeFile(join(testDir, "bad.afps"), "not a valid zip");

    const result = await loadSystemPackages(testDir);
    expect(result.packages).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.file).toBe("bad.afps");
  });

  test("reports ZIPs with missing manifest name as warnings", async () => {
    const zip = makeZip({
      "manifest.json": JSON.stringify({ version: "1.0.0", type: "provider" }),
    });
    await writeFile(join(testDir, "noname.afps"), zip);

    const result = await loadSystemPackages(testDir);
    expect(result.packages).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.error).toContain("name");
  });

  test("returns empty for non-existent directory", async () => {
    const result = await loadSystemPackages(join(testDir, "does-not-exist"));
    expect(result.packages).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("returns empty for empty directory", async () => {
    const emptyDir = join(testDir, "empty");
    await mkdir(emptyDir);

    const result = await loadSystemPackages(emptyDir);
    expect(result.packages).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("preserves zipBuffer for each entry", async () => {
    const zip = makeZip({ "manifest.json": providerManifest("@test/gmail") });
    await writeFile(join(testDir, "gmail-1.0.0.afps"), zip);

    const result = await loadSystemPackages(testDir);
    expect(result.packages[0]!.zipBuffer).toBeInstanceOf(Buffer);
    expect(result.packages[0]!.zipBuffer.length).toBeGreaterThan(0);
  });

  test("mixes valid and invalid ZIPs", async () => {
    const valid = makeZip({ "manifest.json": providerManifest("@test/gmail") });
    await writeFile(join(testDir, "gmail.afps"), valid);
    await writeFile(join(testDir, "bad.afps"), "corrupted");

    const result = await loadSystemPackages(testDir);
    expect(result.packages).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });
});
