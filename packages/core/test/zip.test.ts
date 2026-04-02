// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
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
    name: "@test/my-flow",
    version: "1.0.0",
    type: "agent",
    schemaVersion: "1.0",
    displayName: "My Flow",
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

function validToolManifest() {
  return JSON.stringify({
    name: "@test/my-tool",
    version: "1.0.0",
    type: "tool",
    entrypoint: "tool.ts",
    tool: {
      name: "my_tool",
      description: "A test tool",
      inputSchema: { type: "object", properties: {} },
    },
  });
}

const validSkillContent = `---
name: my-skill
description: A test skill
---
# Skill content`;

function validProviderManifest() {
  return JSON.stringify({
    name: "@test/my-provider",
    version: "1.0.0",
    type: "provider",
    definition: {
      authMode: "oauth2",
      oauth2: {
        authorizationUrl: "https://example.com/authorize",
        tokenUrl: "https://example.com/token",
        defaultScopes: ["read"],
      },
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

// ─────────────────────────────────────────────
// parsePackageZip
// ─────────────────────────────────────────────

describe("parsePackageZip", () => {
  test("valid flow ZIP", () => {
    const zip = makeZip({
      "manifest.json": validAgentManifest(),
      "prompt.md": "# My prompt\nDo something useful.",
    });
    const result = parsePackageZip(zip);
    expect(result.type).toBe("agent");
    expect(result.content).toContain("My prompt");
    expect(result.manifest.name).toBe("@test/my-flow");
  });

  test("valid skill ZIP", () => {
    const zip = makeZip({
      "manifest.json": validSkillManifest(),
      "SKILL.md": validSkillContent,
    });
    const result = parsePackageZip(zip);
    expect(result.type).toBe("skill");
    expect(result.content).toContain("my-skill");
  });

  test("valid tool ZIP", () => {
    const zip = makeZip({
      "manifest.json": validToolManifest(),
      "tool.ts": validToolSource,
    });
    const result = parsePackageZip(zip);
    expect(result.type).toBe("tool");
    expect(result.content).toContain("registerTool");
  });

  test("valid provider ZIP (manifest-only)", () => {
    const zip = makeZip({
      "manifest.json": validProviderManifest(),
    });
    const result = parsePackageZip(zip);
    expect(result.type).toBe("provider");
    expect(result.content).toContain("oauth2");
    expect(result.manifest.name).toBe("@test/my-provider");
  });

  test("valid provider ZIP with PROVIDER.md", () => {
    const providerDoc = "# My Provider API\n\nBase URL: https://api.example.com\n";
    const zip = makeZip({
      "manifest.json": validProviderManifest(),
      "PROVIDER.md": providerDoc,
    });
    const result = parsePackageZip(zip);
    expect(result.type).toBe("provider");
    expect(result.content).toBe(providerDoc);
    expect(result.manifest.name).toBe("@test/my-provider");
  });

  test("ZIP too large", () => {
    const zip = makeZip({ "manifest.json": validAgentManifest(), "prompt.md": "x" });
    expect(() => parsePackageZip(zip, 1)).toThrow(PackageZipError);
    try {
      parsePackageZip(zip, 1);
    } catch (e) {
      expect((e as PackageZipError).code).toBe("FILE_TOO_LARGE");
    }
  });

  test("missing manifest.json", () => {
    const zip = makeZip({ "prompt.md": "hello" });
    expect(() => parsePackageZip(zip)).toThrow(PackageZipError);
    try {
      parsePackageZip(zip);
    } catch (e) {
      expect((e as PackageZipError).code).toBe("MISSING_MANIFEST");
    }
  });

  test("invalid manifest JSON", () => {
    const zip = makeZip({ "manifest.json": "not json{{{" });
    expect(() => parsePackageZip(zip)).toThrow(PackageZipError);
    try {
      parsePackageZip(zip);
    } catch (e) {
      expect((e as PackageZipError).code).toBe("INVALID_MANIFEST");
    }
  });

  test("manifest validation failure", () => {
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

  test("flow missing prompt.md", () => {
    const zip = makeZip({ "manifest.json": validAgentManifest() });
    expect(() => parsePackageZip(zip)).toThrow(PackageZipError);
    try {
      parsePackageZip(zip);
    } catch (e) {
      expect((e as PackageZipError).code).toBe("MISSING_CONTENT");
    }
  });

  test("skill missing SKILL.md", () => {
    const zip = makeZip({ "manifest.json": validSkillManifest() });
    expect(() => parsePackageZip(zip)).toThrow(PackageZipError);
    try {
      parsePackageZip(zip);
    } catch (e) {
      expect((e as PackageZipError).code).toBe("MISSING_CONTENT");
    }
  });

  test("tool missing entrypoint file", () => {
    const zip = makeZip({ "manifest.json": validToolManifest() });
    expect(() => parsePackageZip(zip)).toThrow(PackageZipError);
    try {
      parsePackageZip(zip);
    } catch (e) {
      expect((e as PackageZipError).code).toBe("MISSING_CONTENT");
    }
  });

  test("parsePackageZip returns raw manifest without Zod defaults", () => {
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

    // Raw manifest preserved — no Zod defaults injected
    expect(result.manifest).toEqual(manifest);

    expect(result.manifest.dependencies).toBeUndefined();
    expect(result.manifest.providersConfiguration).toBeUndefined();

    // Custom field preserved
    expect(result.manifest.customField).toBe("must-survive");
  });
});

// ─────────────────────────────────────────────
// zipArtifact / unzipArtifact roundtrip
// ─────────────────────────────────────────────

describe("zipArtifact / unzipArtifact roundtrip", () => {
  test("roundtrip preserves content", () => {
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
  test("filters out path traversal entries (../)", () => {
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

  test("filters out absolute path entries", () => {
    const entries = {
      "safe.txt": new TextEncoder().encode("ok"),
      "/etc/passwd": new TextEncoder().encode("malicious"),
    };
    const zipped = zipArtifact(entries);
    const files = unzipArtifact(zipped);

    expect(files["safe.txt"]).toBeDefined();
    expect(files["/etc/passwd"]).toBeUndefined();
  });

  test("filters out __MACOSX entries", () => {
    const entries = {
      "safe.txt": new TextEncoder().encode("ok"),
      "__MACOSX/._safe.txt": new TextEncoder().encode("metadata"),
    };
    const zipped = zipArtifact(entries);
    const files = unzipArtifact(zipped);

    expect(files["safe.txt"]).toBeDefined();
    expect(files["__MACOSX/._safe.txt"]).toBeUndefined();
  });

  test("allows filenames with consecutive dots (not path traversal)", () => {
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

  test("filters out bare .. entry", () => {
    const entries = {
      "safe.txt": new TextEncoder().encode("ok"),
      "..": new TextEncoder().encode("malicious"),
    };
    const zipped = zipArtifact(entries);
    const files = unzipArtifact(zipped);

    expect(files["safe.txt"]).toBeDefined();
    expect(files[".."]).toBeUndefined();
  });

  test("filters out trailing dir/.. entry", () => {
    const entries = {
      "safe.txt": new TextEncoder().encode("ok"),
      "dir/..": new TextEncoder().encode("malicious"),
    };
    const zipped = zipArtifact(entries);
    const files = unzipArtifact(zipped);

    expect(files["safe.txt"]).toBeDefined();
    expect(files["dir/.."]).toBeUndefined();
  });

  test("filters out backslash entries", () => {
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

  test("filters out null byte entries", () => {
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
  test("rejects ZIP with decompressed size exceeding limit", () => {
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
// Tool entrypoint detection with prefix
// ─────────────────────────────────────────────

describe("tool entrypoint detection", () => {
  test("folder-wrapped tool ZIP is parsed correctly", () => {
    const zip = makeZip({
      "wrapper/manifest.json": validToolManifest(),
      "wrapper/tool.ts": validToolSource,
    });
    const result = parsePackageZip(zip);
    expect(result.type).toBe("tool");
    expect(result.content).toContain("registerTool");
  });

  test("ignores .d.ts files for tool detection", () => {
    const zip = makeZip({
      "manifest.json": validToolManifest(),
      "types.d.ts": "declare module 'foo';",
      "tool.ts": validToolSource,
    });
    const result = parsePackageZip(zip);
    expect(result.type).toBe("tool");
  });
});

// ─────────────────────────────────────────────
// Wrapper folder stripping — parsePackageZip integration
// ─────────────────────────────────────────────

describe("wrapper folder stripping (parsePackageZip)", () => {
  test("wrapped flow ZIP", () => {
    const zip = makeZip({
      "my-flow/manifest.json": validAgentManifest(),
      "my-flow/prompt.md": "# My prompt\nDo something useful.",
    });
    const result = parsePackageZip(zip);
    expect(result.type).toBe("agent");
    expect(result.content).toContain("My prompt");
  });

  test("wrapped skill ZIP", () => {
    const zip = makeZip({
      "my-skill/manifest.json": validSkillManifest(),
      "my-skill/SKILL.md": validSkillContent,
    });
    const result = parsePackageZip(zip);
    expect(result.type).toBe("skill");
    expect(result.content).toContain("my-skill");
  });

  test("wrapped provider ZIP with PROVIDER.md", () => {
    const providerDoc = "# My Provider\n\nBase URL: https://api.example.com\n";
    const zip = makeZip({
      "my-provider/manifest.json": validProviderManifest(),
      "my-provider/PROVIDER.md": providerDoc,
    });
    const result = parsePackageZip(zip);
    expect(result.type).toBe("provider");
    expect(result.content).toBe(providerDoc);
  });

  test("wrapped provider ZIP (manifest-only)", () => {
    const zip = makeZip({
      "my-provider/manifest.json": validProviderManifest(),
    });
    const result = parsePackageZip(zip);
    expect(result.type).toBe("provider");
  });

  test("mixed top-level entries (root + folder) — no stripping", () => {
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

  test("multiple top-level folders — no stripping", () => {
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

  test("nested folders inside wrapper are preserved", () => {
    const toolManifest = JSON.stringify({
      name: "@test/my-tool",
      version: "1.0.0",
      type: "tool",
      entrypoint: "lib/tool.ts",
      tool: {
        name: "my_tool",
        description: "A test tool",
        inputSchema: { type: "object", properties: {} },
      },
    });
    const zip = makeZip({
      "wrapper/manifest.json": toolManifest,
      "wrapper/lib/tool.ts": validToolSource,
      "wrapper/scripts/helper.py": "print('hi')",
    });
    const result = parsePackageZip(zip);
    expect(result.type).toBe("tool");
    expect(result.files["lib/tool.ts"]).toBeDefined();
    expect(result.files["scripts/helper.py"]).toBeDefined();
    expect(result.files["wrapper/lib/tool.ts"]).toBeUndefined();
  });

  test("returned files have stripped keys", () => {
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

  test("double wrapper (two levels) — not stripped to root", () => {
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

  test("empty record returns empty", () => {
    expect(stripWrapperPrefix({})).toEqual({});
  });

  test("root-level file — no stripping", () => {
    const files = { "file.txt": enc("ok") };
    const result = stripWrapperPrefix(files);
    expect(result["file.txt"]).toBeDefined();
  });

  test("single wrapped file — strips prefix", () => {
    const files = { "dir/file.txt": enc("ok") };
    const result = stripWrapperPrefix(files);
    expect(result["file.txt"]).toBeDefined();
    expect(result["dir/file.txt"]).toBeUndefined();
  });

  test("all same prefix — strips", () => {
    const files = {
      "pkg/a.txt": enc("a"),
      "pkg/b.txt": enc("b"),
      "pkg/sub/c.txt": enc("c"),
    };
    const result = stripWrapperPrefix(files);
    expect(Object.keys(result).sort()).toEqual(["a.txt", "b.txt", "sub/c.txt"]);
  });

  test("multiple prefixes — no stripping", () => {
    const files = {
      "dir-a/a.txt": enc("a"),
      "dir-b/b.txt": enc("b"),
    };
    const result = stripWrapperPrefix(files);
    expect(result["dir-a/a.txt"]).toBeDefined();
    expect(result["dir-b/b.txt"]).toBeDefined();
  });

  test("mix of root and folder — no stripping", () => {
    const files = {
      "root.txt": enc("r"),
      "dir/nested.txt": enc("n"),
    };
    const result = stripWrapperPrefix(files);
    expect(result["root.txt"]).toBeDefined();
    expect(result["dir/nested.txt"]).toBeDefined();
  });
});
