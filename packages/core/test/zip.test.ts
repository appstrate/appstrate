// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  parsePackageZip,
  PackageZipError,
  zipArtifact,
  unzipArtifact,
  stripWrapperPrefix,
} from "../src/zip.ts";
import { formatErrorChain } from "../src/errors.ts";

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
    schema_version: "0.1",
    display_name: "My Agent",
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
    type: "integration",
    name: "@test/my-integration",
    version: "1.0.0",
    schema_version: "0.1",
    display_name: "My Integration",
    source: { kind: "local", server: { name: "@test/my-integration-server", version: "^1.0.0" } },
    auths: {
      key: {
        type: "api_key",
        credentials: { schema: { type: "object", properties: { token: { type: "string" } } } },
        authorized_uris: ["https://api.example.com/**"],
        delivery: { env: { TOKEN: { value: "{$credential.token}", sensitive: true } } },
      },
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
      type: "integration",
      name: "@test/broken",
      version: "1.0.0",
      schema_version: "0.1",
      display_name: "Broken",
      // missing source + auths
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
    expect(() => parsePackageZip(zip, { maxSize: 1 })).toThrow(PackageZipError);
    try {
      parsePackageZip(zip, { maxSize: 1 });
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
      schema_version: "0.1",
      display_name: "Raw Roundtrip Test",
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
    expect(agentManifest.integrations_configuration).toBeUndefined();

    // Custom field preserved
    expect(agentManifest.customField).toBe("must-survive");
  });

  // ── retired `runtime_tools` policy ──
  //
  // `report` was a selectable runtime tool until it was removed from the enum.
  // ZIPs published before the removal are immutable, so the parse boundary has
  // to be directional: the default REJECTS (author input), and read paths opt
  // into "drop" explicitly.

  function legacyAgentZip(): Uint8Array {
    return makeZip({
      "manifest.json": JSON.stringify({
        name: "@test/legacy-agent",
        version: "1.0.0",
        type: "agent",
        schema_version: "0.1",
        display_name: "Legacy Agent",
        author: "test",
        runtime_tools: ["output", "report"],
      }),
      "prompt.md": "# Legacy prompt",
    });
  }

  it("rejects a retired runtime_tools id by default (author input)", () => {
    expect(() => parsePackageZip(legacyAgentZip())).toThrow(PackageZipError);
    try {
      parsePackageZip(legacyAgentZip());
      expect.unreachable();
    } catch (e) {
      expect((e as PackageZipError).code).toBe("INVALID_MANIFEST");
      expect((e as PackageZipError).message).toContain("runtime_tools");
    }
  });

  it("rejects a retired runtime_tools id under an explicit reject policy", () => {
    expect(() => parsePackageZip(legacyAgentZip(), { retiredRuntimeTools: "reject" })).toThrow(
      PackageZipError,
    );
  });

  it("drops a retired runtime_tools id and reports it when the caller opts in", () => {
    const result = parsePackageZip(legacyAgentZip(), { retiredRuntimeTools: "drop" });
    expect((result.manifest as Record<string, unknown>).runtime_tools).toEqual(["output"]);
    expect(result.droppedRuntimeTools).toEqual(["report"]);
  });

  it("reports no dropped runtime tools for a manifest with none retired", () => {
    const zip = makeZip({
      "manifest.json": validAgentManifest(),
      "prompt.md": "# Test prompt",
    });
    expect(parsePackageZip(zip, { retiredRuntimeTools: "drop" }).droppedRuntimeTools).toEqual([]);
    expect(parsePackageZip(zip).droppedRuntimeTools).toEqual([]);
  });

  it("honours maxSize in both directions", () => {
    const zip = makeZip({
      "manifest.json": validAgentManifest(),
      "prompt.md": "# Test prompt",
    });
    expect(() => parsePackageZip(zip, { maxSize: 1 })).toThrow(PackageZipError);
    expect(parsePackageZip(zip, { maxSize: 10 * 1024 * 1024 }).packageId).toBe("@test/my-agent");
  });

  // `@appstrate/core` is published, so the retired positional `maxSize` can
  // still arrive from an out-of-tree consumer that never sees the TypeScript
  // signature. It must fail loudly rather than fall through to the default
  // ceiling (`docs/NO_TRANSITIONAL_CODE.md` step 5). The `as never` is the
  // point of the test: only a caller the compiler cannot reach can do this.
  it("rejects the retired bare-number maxSize argument", () => {
    const zip = makeZip({
      "manifest.json": validAgentManifest(),
      "prompt.md": "# Test prompt",
    });
    // A limit the archive would PASS under, so a silent fall-through to the
    // default would parse happily and this test would go green for the wrong
    // reason. The throw is the only thing that can make it fail.
    const retired = (10 * 1024 * 1024) as never;
    expect(() => parsePackageZip(zip, retired)).toThrow(TypeError);
    // Not a `PackageZipError`: the archive is fine, the call is not — and
    // `PackageZipError` is what the upload route renders into an uploader's 400.
    expect(() => parsePackageZip(zip, retired)).not.toThrow(PackageZipError);
    try {
      parsePackageZip(zip, retired);
    } catch (e) {
      // The message alone has to tell an out-of-tree author what to change: it
      // names the retired form, the replacement option object, and the very
      // value they passed.
      const message = (e as Error).message;
      expect(message).toContain("bare-number");
      expect(message).toContain("maxSize");
      expect(message).toContain("ParsePackageZipOptions");
      expect(message).toContain(String(10 * 1024 * 1024));
    }
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

describe("zipArtifact determinism", () => {
  it("produces identical bytes across builds (fixed mtime)", () => {
    const entries = {
      "manifest.json": new TextEncoder().encode('{"a":1}'),
      "prompt.md": new TextEncoder().encode("hello"),
    };
    const a = zipArtifact(entries);
    const b = zipArtifact(entries);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("is independent of entry insertion order (sorted output)", () => {
    const forward = zipArtifact({
      "a.txt": new TextEncoder().encode("1"),
      "b.txt": new TextEncoder().encode("2"),
      "c.txt": new TextEncoder().encode("3"),
    });
    const reversed = zipArtifact({
      "c.txt": new TextEncoder().encode("3"),
      "b.txt": new TextEncoder().encode("2"),
      "a.txt": new TextEncoder().encode("1"),
    });
    expect(Buffer.from(forward).equals(Buffer.from(reversed))).toBe(true);
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

    expect(() => parsePackageZip(zipped, { maxSize: 100 * 1024 * 1024 })).toThrow(PackageZipError);
    try {
      parsePackageZip(zipped, { maxSize: 100 * 1024 * 1024 });
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

describe("PackageZipError carries what actually failed", () => {
  it("attaches the JSON SyntaxError as the cause of INVALID_MANIFEST", () => {
    // Delete-to-fail: drop the `{ cause: err }` in `parsePackageZip` and a
    // truncated manifest, a stray BOM and a trailing comma all report the same
    // sentence — "manifest.json is not valid JSON" — with nothing saying where.
    const zip = makeZip({ "manifest.json": '{ "name": "@test/a", ' });
    try {
      parsePackageZip(zip);
      throw new Error("expected parsePackageZip to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(PackageZipError);
      const err = e as PackageZipError;
      expect(err.code).toBe("INVALID_MANIFEST");
      expect(err.cause).toBeInstanceOf(SyntaxError);
      // Reachable, not merely stored: this is what a log line renders.
      expect(formatErrorChain(err).length).toBeGreaterThan(err.message.length);
    }
  });
});

describe("ZIP_INVALID names what was wrong with the bytes", () => {
  // `routes/packages.ts` renders `PackageZipError.message` into the 400 the
  // uploader sees and nothing renders a `cause` there, so the message is the
  // whole report. The corrupt-archive branch used to throw a fixed
  // "Failed to decompress ZIP artifact", which is the one branch that means
  // "your archive is structurally broken" — precisely the case an uploader can
  // act on — and it discarded the only sentence that said HOW.
  //
  // Two inputs that must NOT report the same thing:
  it("distinguishes a non-ZIP payload from a corrupted deflate stream", () => {
    const notAZip = new TextEncoder().encode("this is not a zip at all, it is prose");
    const corrupted = new Uint8Array(
      makeZip({ "manifest.json": "a".repeat(5000) + "b".repeat(5000) }),
    );
    // Flip bytes inside the deflate payload — the header stays a valid `PK`
    // signature, so this fails mid-inflate rather than on the magic check.
    for (let i = 60; i < 80; i++) corrupted[i] = corrupted[i]! ^ 0xff;

    const messages: string[] = [];
    for (const bytes of [notAZip, corrupted]) {
      try {
        parsePackageZip(bytes);
        throw new Error("expected parsePackageZip to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(PackageZipError);
        const err = e as PackageZipError;
        expect(err.code).toBe("ZIP_INVALID");
        messages.push(err.message);
      }
    }

    expect(messages[0]).toContain("not a ZIP archive");
    expect(messages[1]).toContain("invalid distance");
    // The discriminating half: a fixed string would make these equal.
    expect(messages[0]).not.toBe(messages[1]);
  });

  it("still attaches the DecompressionLimitError as the cause", () => {
    try {
      parsePackageZip(new TextEncoder().encode("this is not a zip at all"));
      throw new Error("expected parsePackageZip to throw");
    } catch (e) {
      const err = e as PackageZipError;
      expect((err.cause as Error | undefined)?.name).toBe("DecompressionLimitError");
    }
  });

  // Negative control for the sibling branch: ZIP_BOMB stays deliberately
  // opaque. Its `DecompressionLimitError` detail can be an archive ENTRY NAME
  // (`file-too-large` passes `file.name`), which is uploader-controlled text,
  // and "decompressed size exceeds limit" is already a complete, actionable
  // report — there is nothing a decoder sentence would add.
  it("leaves the ZIP_BOMB message fixed", () => {
    // 51 MB of a single repeated byte deflates to a few dozen KB, so it clears
    // the 10 MB compressed ceiling and blows the 50 MB decompressed budget.
    const payload = new Uint8Array(51 * 1024 * 1024);
    payload.fill(65);
    const bomb = zipArtifact({
      "manifest.json": new TextEncoder().encode(validAgentManifest()),
      "big.bin": payload,
    });
    try {
      parsePackageZip(bomb);
      throw new Error("expected parsePackageZip to throw");
    } catch (e) {
      const err = e as PackageZipError;
      expect(err.code).toBe("ZIP_BOMB");
      expect(err.message).toBe("Decompressed size exceeds limit");
    }
  });
});
