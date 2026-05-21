// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  parsePackageZip,
  PackageZipError,
  zipArtifact,
  unzipArtifact,
  stripWrapperPrefix,
} from "../src/zip.ts";

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

function validAgentManifest() {
  return JSON.stringify({
    name: "@test/my-agent",
    version: "1.0.0",
    type: "agent",
    schemaVersion: "1.0",
    displayName: "My Agent",
    author: "test",
  });
}

function validSkillManifest() {
  return JSON.stringify({
    name: "@test/my-skill",
    version: "1.0.0",
    type: "skill",
  });
}

const validSkillContent = `---
name: my-skill
description: A test skill
---
# Skill content`;

function validIntegrationManifest() {
  return JSON.stringify({
    manifestVersion: "1.1",
    type: "integration",
    name: "@test/my-integration",
    version: "1.0.0",
    displayName: "My Integration",
    server: {
      type: "node",
      entryPoint: "./server/index.js",
    },
  });
}

// ─────────────────────────────────────────────
// parsePackageZip
// ─────────────────────────────────────────────

describe("parsePackageZip", () => {
  it("valid agent ZIP", () => {
    const zip = makeZip({
      "manifest.json": validAgentManifest(),
      "prompt.md": "# My prompt\nDo something useful.",
    });
    const result = parsePackageZip(zip);
    expect(result.type).toBe("agent");
    expect(result.content).toContain("My prompt");
    expect(result.manifest.name).toBe("@test/my-agent");
  });

  it("valid skill ZIP", () => {
    const zip = makeZip({
      "manifest.json": validSkillManifest(),
      "SKILL.md": validSkillContent,
    });
    const result = parsePackageZip(zip);
    expect(result.type).toBe("skill");
    expect(result.content).toContain("my-skill");
  });

  it("valid integration ZIP (manifest-only)", () => {
    const zip = makeZip({
      "manifest.json": validIntegrationManifest(),
      "server/index.js": "/* vendored MCP server */",
    });
    const result = parsePackageZip(zip);
    expect(result.type).toBe("integration");
    expect(result.manifest.name).toBe("@test/my-integration");
    // No INTEGRATION.md present → content falls back to manifest text.
    expect(result.content).toContain("@test/my-integration");
  });

  it("valid integration ZIP with INTEGRATION.md companion", () => {
    const doc = "# Integration agent-facing doc\n\nWhat this MCP server does.\n";
    const zip = makeZip({
      "manifest.json": validIntegrationManifest(),
      "INTEGRATION.md": doc,
      "server/index.js": "/* vendored */",
    });
    const result = parsePackageZip(zip);
    expect(result.type).toBe("integration");
    expect(result.content).toBe(doc);
  });

  it("rejects an integration manifest missing required fields", () => {
    const incomplete = JSON.stringify({
      manifestVersion: "1.1",
      type: "integration",
      name: "@test/broken",
      version: "1.0.0",
      // missing displayName + server
    });
    const zip = makeZip({ "manifest.json": incomplete });
    expect(() => parsePackageZip(zip)).toThrow(PackageZipError);
    try {
      parsePackageZip(zip);
    } catch (e) {
      expect((e as PackageZipError).code).toBe("INVALID_MANIFEST");
    }
  });

  it("ZIP too large", () => {
    const zip = makeZip({ "manifest.json": validAgentManifest(), "prompt.md": "x" });
    expect(() => parsePackageZip(zip, 1)).toThrow(PackageZipError);
    try {
      parsePackageZip(zip, 1);
    } catch (e) {
      expect((e as PackageZipError).code).toBe("FILE_TOO_LARGE");
    }
  });

  it("missing manifest.json", () => {
    const zip = makeZip({ "prompt.md": "hello" });
    expect(() => parsePackageZip(zip)).toThrow(PackageZipError);
    try {
      parsePackageZip(zip);
    } catch (e) {
      expect((e as PackageZipError).code).toBe("MISSING_MANIFEST");
    }
  });

  it("invalid manifest JSON", () => {
    const zip = makeZip({ "manifest.json": "not json{{{" });
    expect(() => parsePackageZip(zip)).toThrow(PackageZipError);
    try {
      parsePackageZip(zip);
    } catch (e) {
      expect((e as PackageZipError).code).toBe("INVALID_MANIFEST");
    }
  });

  it("manifest validation failure", () => {
    const zip = makeZip({
      "manifest.json": JSON.stringify({ type: "skill" }),
      "SKILL.md": validSkillContent,
    });
    expect(() => parsePackageZip(zip)).toThrow(PackageZipError);
    try {
      parsePackageZip(zip);
    } catch (e) {
      expect((e as PackageZipError).code).toBe("INVALID_MANIFEST");
    }
  });

  it("agent missing prompt.md", () => {
    const zip = makeZip({ "manifest.json": validAgentManifest() });
    expect(() => parsePackageZip(zip)).toThrow(PackageZipError);
    try {
      parsePackageZip(zip);
    } catch (e) {
      expect((e as PackageZipError).code).toBe("MISSING_CONTENT");
    }
  });

  it("skill missing SKILL.md", () => {
    const zip = makeZip({ "manifest.json": validSkillManifest() });
    expect(() => parsePackageZip(zip)).toThrow(PackageZipError);
    try {
      parsePackageZip(zip);
    } catch (e) {
      expect((e as PackageZipError).code).toBe("MISSING_CONTENT");
    }
  });

  it("parsePackageZip returns raw manifest without Zod defaults", () => {
    // Manifest with required fields only — NO optional defaults
    const manifest = {
      name: "@test/raw-roundtrip",
      version: "1.0.0",
      type: "agent" as const,
      schemaVersion: "1.0",
      displayName: "Raw Roundtrip Test",
      author: "test",
      // dependencies and timeout intentionally omitted
      customField: "must-survive",
    };

    const zip = makeZip({
      "manifest.json": JSON.stringify(manifest),
      "prompt.md": "# Test prompt",
    });

    const result = parsePackageZip(zip);
    // Manifest is narrowed by `type === "agent"` here — cast for field access.
    const agentManifest = result.manifest as Record<string, unknown>;

    // Raw manifest preserved — no Zod defaults injected
    expect(result.manifest).toEqual(manifest);

    expect(agentManifest.dependencies).toBeUndefined();
    expect(agentManifest.providersConfiguration).toBeUndefined();

    // Custom field preserved
    expect(agentManifest.customField).toBe("must-survive");
  });
});

// ─────────────────────────────────────────────
// zipArtifact / unzipArtifact roundtrip
// ─────────────────────────────────────────────

describe("zipArtifact / unzipArtifact roundtrip", () => {
  it("roundtrip preserves content", () => {
    const entries = {
      "a.txt": new TextEncoder().encode("hello"),
      "dir/b.txt": new TextEncoder().encode("world"),
    };
    const zipped = zipArtifact(entries);
    const files = unzipArtifact(zipped);

    expect(new TextDecoder().decode(files["a.txt"])).toBe("hello");
    expect(new TextDecoder().decode(files["dir/b.txt"])).toBe("world");
  });
});

// ─────────────────────────────────────────────
// Path traversal & sanitization
// ─────────────────────────────────────────────

describe("unzipArtifact sanitization", () => {
  it("filters out path traversal entries (../)", () => {
    const entries = {
      "safe.txt": new TextEncoder().encode("ok"),
      "../etc/passwd": new TextEncoder().encode("malicious"),
      "dir/../../secret": new TextEncoder().encode("malicious"),
    };
    const zipped = zipArtifact(entries);
    const files = unzipArtifact(zipped);

    expect(files["safe.txt"]).toBeDefined();
    expect(files["../etc/passwd"]).toBeUndefined();
    expect(files["dir/../../secret"]).toBeUndefined();
  });

  it("filters out absolute path entries", () => {
    const entries = {
      "safe.txt": new TextEncoder().encode("ok"),
      "/etc/passwd": new TextEncoder().encode("malicious"),
    };
    const zipped = zipArtifact(entries);
    const files = unzipArtifact(zipped);

    expect(files["safe.txt"]).toBeDefined();
    expect(files["/etc/passwd"]).toBeUndefined();
  });

  it("filters out __MACOSX entries", () => {
    const entries = {
      "safe.txt": new TextEncoder().encode("ok"),
      "__MACOSX/._safe.txt": new TextEncoder().encode("metadata"),
    };
    const zipped = zipArtifact(entries);
    const files = unzipArtifact(zipped);

    expect(files["safe.txt"]).toBeDefined();
    expect(files["__MACOSX/._safe.txt"]).toBeUndefined();
  });

  it("allows filenames with consecutive dots (not path traversal)", () => {
    const entries = {
      "file..txt": new TextEncoder().encode("ok1"),
      "notes...md": new TextEncoder().encode("ok2"),
      "dir/file..backup.txt": new TextEncoder().encode("ok3"),
    };
    const zipped = zipArtifact(entries);
    const files = unzipArtifact(zipped);

    expect(files["file..txt"]).toBeDefined();
    expect(files["notes...md"]).toBeDefined();
    expect(files["dir/file..backup.txt"]).toBeDefined();
  });

  it("filters out bare .. entry", () => {
    const entries = {
      "safe.txt": new TextEncoder().encode("ok"),
      "..": new TextEncoder().encode("malicious"),
    };
    const zipped = zipArtifact(entries);
    const files = unzipArtifact(zipped);

    expect(files["safe.txt"]).toBeDefined();
    expect(files[".."]).toBeUndefined();
  });

  it("filters out trailing dir/.. entry", () => {
    const entries = {
      "safe.txt": new TextEncoder().encode("ok"),
      "dir/..": new TextEncoder().encode("malicious"),
    };
    const zipped = zipArtifact(entries);
    const files = unzipArtifact(zipped);

    expect(files["safe.txt"]).toBeDefined();
    expect(files["dir/.."]).toBeUndefined();
  });

  it("filters out backslash entries", () => {
    const entries = {
      "safe.txt": new TextEncoder().encode("ok"),
      "dir\\file.txt": new TextEncoder().encode("malicious"),
      "..\\etc\\passwd": new TextEncoder().encode("malicious"),
    };
    const zipped = zipArtifact(entries);
    const files = unzipArtifact(zipped);

    expect(files["safe.txt"]).toBeDefined();
    expect(files["dir\\file.txt"]).toBeUndefined();
    expect(files["..\\etc\\passwd"]).toBeUndefined();
  });

  it("filters out null byte entries", () => {
    const entries = {
      "safe.txt": new TextEncoder().encode("ok"),
      "evil\0.txt": new TextEncoder().encode("malicious"),
    };
    const zipped = zipArtifact(entries);
    const files = unzipArtifact(zipped);

    expect(files["safe.txt"]).toBeDefined();
    expect(files["evil\0.txt"]).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// Zip bomb protection
// ─────────────────────────────────────────────

describe("zip bomb protection", () => {
  it("rejects ZIP with decompressed size exceeding limit", () => {
    // Create a ZIP with a large repeated payload
    const bigContent = new Uint8Array(51 * 1024 * 1024); // 51 MB
    bigContent.fill(65); // 'A'
    const entries = {
      "manifest.json": new TextEncoder().encode(validAgentManifest()),
      "prompt.md": new TextEncoder().encode("# Prompt"),
      "big.bin": bigContent,
    };
    const zipped = zipArtifact(entries);

    expect(() => parsePackageZip(zipped, 100 * 1024 * 1024)).toThrow(PackageZipError);
    try {
      parsePackageZip(zipped, 100 * 1024 * 1024);
    } catch (e) {
      expect((e as PackageZipError).code).toBe("ZIP_BOMB");
    }
  });
});

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// Wrapper folder stripping — parsePackageZip integration
// ─────────────────────────────────────────────

describe("wrapper folder stripping (parsePackageZip)", () => {
  it("wrapped agent ZIP", () => {
    const zip = makeZip({
      "my-agent/manifest.json": validAgentManifest(),
      "my-agent/prompt.md": "# My prompt\nDo something useful.",
    });
    const result = parsePackageZip(zip);
    expect(result.type).toBe("agent");
    expect(result.content).toContain("My prompt");
  });

  it("wrapped skill ZIP", () => {
    const zip = makeZip({
      "my-skill/manifest.json": validSkillManifest(),
      "my-skill/SKILL.md": validSkillContent,
    });
    const result = parsePackageZip(zip);
    expect(result.type).toBe("skill");
    expect(result.content).toContain("my-skill");
  });

  it("mixed top-level entries (root + folder) — no stripping", () => {
    const zip = makeZip({
      "folder/manifest.json": validAgentManifest(),
      "stray-file.txt": "hello",
    });
    expect(() => parsePackageZip(zip)).toThrow(PackageZipError);
    try {
      parsePackageZip(zip);
    } catch (e) {
      expect((e as PackageZipError).code).toBe("MISSING_MANIFEST");
    }
  });

  it("multiple top-level folders — no stripping", () => {
    const zip = makeZip({
      "folder-a/manifest.json": validAgentManifest(),
      "folder-b/prompt.md": "# Prompt",
    });
    expect(() => parsePackageZip(zip)).toThrow(PackageZipError);
    try {
      parsePackageZip(zip);
    } catch (e) {
      expect((e as PackageZipError).code).toBe("MISSING_MANIFEST");
    }
  });

  it("nested folders inside wrapper are preserved", () => {
    const zip = makeZip({
      "wrapper/manifest.json": validSkillManifest(),
      "wrapper/SKILL.md": validSkillContent,
      "wrapper/lib/helper.ts": "export const x = 1;",
      "wrapper/scripts/helper.py": "print('hi')",
    });
    const result = parsePackageZip(zip);
    expect(result.type).toBe("skill");
    expect(result.files["lib/helper.ts"]).toBeDefined();
    expect(result.files["scripts/helper.py"]).toBeDefined();
    expect(result.files["wrapper/lib/helper.ts"]).toBeUndefined();
  });

  it("returned files have stripped keys", () => {
    const zip = makeZip({
      "wrapper/manifest.json": validAgentManifest(),
      "wrapper/prompt.md": "# Prompt",
    });
    const result = parsePackageZip(zip);
    expect(result.files["manifest.json"]).toBeDefined();
    expect(result.files["prompt.md"]).toBeDefined();
    expect(result.files["wrapper/manifest.json"]).toBeUndefined();
    expect(result.files["wrapper/prompt.md"]).toBeUndefined();
  });

  it("double wrapper (two levels) — not stripped to root", () => {
    const zip = makeZip({
      "a/b/manifest.json": validAgentManifest(),
      "a/b/prompt.md": "# Prompt",
    });
    // Strips "a/" → files become "b/manifest.json", "b/prompt.md" → manifest not at root
    expect(() => parsePackageZip(zip)).toThrow(PackageZipError);
    try {
      parsePackageZip(zip);
    } catch (e) {
      expect((e as PackageZipError).code).toBe("MISSING_MANIFEST");
    }
  });
});

// ─────────────────────────────────────────────
// stripWrapperPrefix — unit tests
// ─────────────────────────────────────────────

describe("stripWrapperPrefix", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("empty record returns empty", () => {
    expect(stripWrapperPrefix({})).toEqual({});
  });

  it("root-level file — no stripping", () => {
    const files = { "file.txt": enc("ok") };
    const result = stripWrapperPrefix(files);
    expect(result["file.txt"]).toBeDefined();
  });

  it("single wrapped file — strips prefix", () => {
    const files = { "dir/file.txt": enc("ok") };
    const result = stripWrapperPrefix(files);
    expect(result["file.txt"]).toBeDefined();
    expect(result["dir/file.txt"]).toBeUndefined();
  });

  it("all same prefix — strips", () => {
    const files = {
      "pkg/a.txt": enc("a"),
      "pkg/b.txt": enc("b"),
      "pkg/sub/c.txt": enc("c"),
    };
    const result = stripWrapperPrefix(files);
    expect(Object.keys(result).sort()).toEqual(["a.txt", "b.txt", "sub/c.txt"]);
  });

  it("multiple prefixes — no stripping", () => {
    const files = {
      "dir-a/a.txt": enc("a"),
      "dir-b/b.txt": enc("b"),
    };
    const result = stripWrapperPrefix(files);
    expect(result["dir-a/a.txt"]).toBeDefined();
    expect(result["dir-b/b.txt"]).toBeDefined();
  });

  it("mix of root and folder — no stripping", () => {
    const files = {
      "root.txt": enc("r"),
      "dir/nested.txt": enc("n"),
    };
    const result = stripWrapperPrefix(files);
    expect(result["root.txt"]).toBeDefined();
    expect(result["dir/nested.txt"]).toBeDefined();
  });

  // Map<string, Uint8Array> overload — mirrors the afps-runtime shape.
  it("empty map returns empty map", () => {
    const out = stripWrapperPrefix(new Map<string, Uint8Array>());
    expect(out).toBeInstanceOf(Map);
    expect(out.size).toBe(0);
  });

  it("Map: single wrapper prefix — strips and returns Map", () => {
    const files = new Map<string, Uint8Array>([
      ["pkg/a.txt", enc("a")],
      ["pkg/sub/b.txt", enc("b")],
    ]);
    const result = stripWrapperPrefix(files);
    expect(result).toBeInstanceOf(Map);
    expect([...result.keys()].sort()).toEqual(["a.txt", "sub/b.txt"]);
  });

  it("Map: root-level file — no stripping, returns same instance", () => {
    const files = new Map<string, Uint8Array>([["file.txt", enc("ok")]]);
    const result = stripWrapperPrefix(files);
    expect(result).toBe(files);
  });

  it("Map: multiple prefixes — no stripping, returns same instance", () => {
    const files = new Map<string, Uint8Array>([
      ["dir-a/a.txt", enc("a")],
      ["dir-b/b.txt", enc("b")],
    ]);
    const result = stripWrapperPrefix(files);
    expect(result).toBe(files);
  });
});
