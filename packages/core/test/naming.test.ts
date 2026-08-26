// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  normalizeScope,
  stripScope,
  parseScopedName,
  buildPackageId,
  encodePackageIdPath,
  isOwnedByOrg,
  isValidToolName,
  TOOL_NAME_MAX_LEN,
  sanitizeFilename,
  attachmentDisposition,
  MAX_FILENAME_LEN,
  encodeFilenameHeader,
  decodeFilenameHeader,
} from "../src/naming.ts";

describe("normalizeScope", () => {
  it('"scope" → "@scope"', () => {
    expect(normalizeScope("scope")).toBe("@scope");
  });

  it('"@scope" → "@scope"', () => {
    expect(normalizeScope("@scope")).toBe("@scope");
  });

  it("throws on empty string", () => {
    expect(() => normalizeScope("")).toThrow("Scope cannot be empty");
  });
});

describe("stripScope", () => {
  it('"@scope" → "scope"', () => {
    expect(stripScope("@scope")).toBe("scope");
  });

  it('"scope" → "scope"', () => {
    expect(stripScope("scope")).toBe("scope");
  });
});

describe("parseScopedName", () => {
  it('"@acme/my-skill" → { scope: "acme", name: "my-skill" }', () => {
    expect(parseScopedName("@acme/my-skill")).toEqual({ scope: "acme", name: "my-skill" });
  });

  it('"invalid" → null', () => {
    expect(parseScopedName("invalid")).toBeNull();
  });

  it('"acme/skill" (no @) → null', () => {
    expect(parseScopedName("acme/skill")).toBeNull();
  });

  it('"@SCOPE/name" (uppercase scope) → null', () => {
    expect(parseScopedName("@SCOPE/name")).toBeNull();
  });

  it('"@scope/NAME" (uppercase name) → null', () => {
    expect(parseScopedName("@scope/NAME")).toBeNull();
  });

  it('"@scope/" (empty name) → null', () => {
    expect(parseScopedName("@scope/")).toBeNull();
  });

  it('"@-scope/name" (scope starts with hyphen) → null', () => {
    expect(parseScopedName("@-scope/name")).toBeNull();
  });

  it('"@scope/name-" (name ends with hyphen) → null', () => {
    expect(parseScopedName("@scope/name-")).toBeNull();
  });

  it('"@a/b" (single-char scope and name) → valid', () => {
    expect(parseScopedName("@a/b")).toEqual({ scope: "a", name: "b" });
  });

  it('"@org123/pkg-name" (alphanumeric with hyphens) → valid', () => {
    expect(parseScopedName("@org123/pkg-name")).toEqual({ scope: "org123", name: "pkg-name" });
  });
});

describe("isOwnedByOrg", () => {
  it('"@acme/my-agent" owned by "acme" → true', () => {
    expect(isOwnedByOrg("@acme/my-agent", "acme")).toBe(true);
  });

  it('"@other/my-agent" owned by "acme" → false', () => {
    expect(isOwnedByOrg("@other/my-agent", "acme")).toBe(false);
  });

  it('"invalid" owned by "acme" → false', () => {
    expect(isOwnedByOrg("invalid", "acme")).toBe(false);
  });

  it('"@acme-labs/my-agent" owned by "acme" → false (no partial match)', () => {
    expect(isOwnedByOrg("@acme-labs/my-agent", "acme")).toBe(false);
  });

  it('"@acme/my-agent" owned by "" → false', () => {
    expect(isOwnedByOrg("@acme/my-agent", "")).toBe(false);
  });
});

describe("buildPackageId", () => {
  it('("@acme", "my-skill") → "@acme/my-skill"', () => {
    expect(buildPackageId("@acme", "my-skill")).toBe("@acme/my-skill");
  });

  it('("acme", "skill") → "@acme/skill" (adds @ prefix)', () => {
    expect(buildPackageId("acme", "skill")).toBe("@acme/skill");
  });

  it('("@org", "a") → "@org/a"', () => {
    expect(buildPackageId("@org", "a")).toBe("@org/a");
  });
});

describe("encodePackageIdPath", () => {
  it('"@foo/bar" → "@foo/bar" (separators stay literal)', () => {
    expect(encodePackageIdPath("@foo/bar")).toBe("@foo/bar");
  });

  it('"@org123/pkg-name" round-trips unchanged', () => {
    expect(encodePackageIdPath("@org123/pkg-name")).toBe("@org123/pkg-name");
  });

  it("output preserves the split route segments", () => {
    const out = encodePackageIdPath("@acme/my-skill");
    // /:packageId{@[^/]+/[^/]+}
    expect(/^@[^/]+\/[^/]+$/.test(out)).toBe(true);
    // /:scope/:name → first segment is the scope param
    const [scope, name] = out.split("/");
    expect(/^@[^/]+$/.test(scope!)).toBe(true);
    expect(name).toBe("my-skill");
  });

  it("throws on missing @ prefix", () => {
    expect(() => encodePackageIdPath("foo/bar")).toThrow("Invalid packageId");
  });

  it("throws on scope-only input", () => {
    expect(() => encodePackageIdPath("@foo")).toThrow("Invalid packageId");
  });

  it("throws on nested (3-segment) input", () => {
    expect(() => encodePackageIdPath("@foo/bar/baz")).toThrow("Invalid packageId");
  });

  it("throws on empty string", () => {
    expect(() => encodePackageIdPath("")).toThrow("Invalid packageId");
  });
});

describe("isValidToolName", () => {
  it("accepts canonical {namespace}__{tool} snake_case", () => {
    expect(isValidToolName("fs__read_file")).toBe(true);
    expect(isValidToolName("notion__search_pages")).toBe(true);
    expect(isValidToolName("a__b")).toBe(true);
  });

  it("rejects names without the __ separator", () => {
    expect(isValidToolName("read_file")).toBe(false);
    expect(isValidToolName("fs_read_file")).toBe(false);
  });

  it("rejects mixed-case", () => {
    expect(isValidToolName("FS__readFile")).toBe(false);
    expect(isValidToolName("Fs__read_file")).toBe(false);
  });

  it("rejects hyphens (mixed separator hurts tokenisation per V3)", () => {
    expect(isValidToolName("mcp-fs__read_file")).toBe(false);
  });

  it("accepts a digit-leading namespace (scopes like @1password are valid slugs)", () => {
    expect(isValidToolName("1password_connect__api_call")).toBe(true);
    expect(isValidToolName("1fs__read_file")).toBe(true);
  });

  it("rejects a digit-leading tool token", () => {
    expect(isValidToolName("fs__1file")).toBe(false);
  });

  it("rejects names exceeding TOOL_NAME_MAX_LEN", () => {
    const long = "a".repeat(60) + "__b";
    expect(long.length).toBeGreaterThan(TOOL_NAME_MAX_LEN);
    expect(isValidToolName(long)).toBe(false);
  });

  it("rejects empty / non-string input", () => {
    expect(isValidToolName("")).toBe(false);
    expect(isValidToolName(undefined as unknown as string)).toBe(false);
  });
});

describe("sanitizeFilename", () => {
  it("leaves a plain name untouched, accents included", () => {
    expect(sanitizeFilename("report.html")).toBe("report.html");
    // "rapport-ete.md" with acute accents: the sanitizer is NOT an ASCII fold.
    expect(sanitizeFilename("rapport-été.md")).toBe("rapport-été.md");
  });

  it("collapses path separators and control characters", () => {
    expect(sanitizeFilename("a/b.txt")).toBe("a_b.txt");
    expect(sanitizeFilename("a\\b.txt")).toBe("a_b.txt");
    expect(sanitizeFilename("head\r\ninjected.txt")).toBe("head__injected.txt");
  });

  it("collapses `..` runs so no traversal segment survives", () => {
    expect(sanitizeFilename("report..md")).toBe("report.md");
    expect(sanitizeFilename("../../etc/passwd")).toBe("._._etc_passwd");
  });

  it("falls back to `file` when nothing is left", () => {
    expect(sanitizeFilename("   ")).toBe("file");
    expect(sanitizeFilename("")).toBe("file");
  });

  it("caps at MAX_FILENAME_LEN", () => {
    expect(sanitizeFilename("x".repeat(400))).toHaveLength(MAX_FILENAME_LEN);
  });

  it("never mints a name that no download can serve", () => {
    // The cut is on UTF-16 code units, so a name whose 255th unit is the FIRST
    // half of a surrogate pair used to be truncated to a lone high surrogate —
    // a string `encodeURIComponent` throws `URIError` on. That name is durable
    // (`files.name`, and part of the `(run_id, sha256, name)` dedup identity),
    // so every later download of the file 500'd, on both serving branches.
    const name = "a".repeat(MAX_FILENAME_LEN - 1) + "\u{1f4ca}";
    const cut = sanitizeFilename(name);

    expect(cut.length).toBeLessThanOrEqual(MAX_FILENAME_LEN);
    // The orphaned half is dropped, not kept: the string is well-formed UTF-16.
    expect(cut).toBe("a".repeat(MAX_FILENAME_LEN - 1));
    expect(() => attachmentDisposition(cut)).not.toThrow();
    expect(() => encodeFilenameHeader(cut)).not.toThrow();

    // A pair that ends BEFORE the cut is untouched — the fix must not eat a
    // legitimate emoji.
    const fits = "a".repeat(MAX_FILENAME_LEN - 3) + "\u{1f4ca}";
    expect(sanitizeFilename(fits)).toBe(fits);
  });
});

describe("filename encoders are total", () => {
  // Both sit on the last line before a response header is written, so a throw
  // here is a 500 on a download that would otherwise have worked. A lone
  // surrogate can reach them from any producer, not just the truncation above.
  const LONE_HIGH = "rapport\ud83d.pdf";
  const LONE_LOW = "rapport\ude00.pdf";

  it("substitutes U+FFFD for an unpaired surrogate instead of throwing", () => {
    for (const name of [LONE_HIGH, LONE_LOW]) {
      expect(() => encodeURIComponent(name)).toThrow();
      expect(() => encodeFilenameHeader(name)).not.toThrow();
      expect(() => attachmentDisposition(name)).not.toThrow();
      expect(encodeFilenameHeader(name)).toBe("rapport%EF%BF%BD.pdf");
    }
  });

  it("leaves a well-formed name byte-identical (control)", () => {
    expect(attachmentDisposition("rapport été.pdf")).toBe(
      "attachment; filename=\"rapport _t_.pdf\"; filename*=UTF-8''rapport%20%C3%A9t%C3%A9.pdf",
    );
    expect(encodeFilenameHeader("\u{1f4ca}.png")).toBe("%F0%9F%93%8A.png");
  });
});

describe("encodeFilenameHeader / decodeFilenameHeader", () => {
  // "baogao.md" in Chinese, "rapport-ete.md" with acute accents, and a
  // bar-chart emoji: the three shapes an agent writing to `outputs/` produces
  // on a French/international product.
  const NON_ASCII = ["报告.md", "rapport-été.md", "\u{1f4ca}.png"];

  it("round-trips a non-ASCII name byte-for-byte", () => {
    for (const name of NON_ASCII) {
      expect(decodeFilenameHeader(encodeFilenameHeader(name))).toBe(name);
    }
  });

  it("emits a header-safe ASCII value for a non-ASCII name", () => {
    for (const name of NON_ASCII) {
      const encoded = encodeFilenameHeader(name);
      expect(encoded).not.toBe(name);
      expect([...encoded].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
    }
  });

  it("is the only form an HTTP header can carry (the bug this encoding fixes)", () => {
    // Two distinct failure modes for a raw name, both fixed by encoding:
    //
    // 1. Outside Latin-1 (CJK, emoji) `Headers` THROWS. In the uploader that
    //    throw lands inside the fetch try, where it is classified as a
    //    retryable network fault: 3 attempts, backoff, then the deliverable is
    //    permanently lost as `upload_failed`.
    for (const name of ["报告.md", "\u{1f4ca}.png"]) {
      expect(() => new Headers({ "X-File-Name": name })).toThrow();
      expect(() => new Headers({ "X-File-Name": encodeFilenameHeader(name) })).not.toThrow();
    }
    // 2. Inside Latin-1 (a French accent) it is ACCEPTED, which is worse: the
    //    value survives the send and is silently mojibaked by the UTF-8 write /
    //    Latin-1 read round-trip on the way in. Encoding removes the ambiguity.
    const accented = "rapport-été.md";
    expect(() => new Headers({ "X-File-Name": accented })).not.toThrow();
    expect(encodeFilenameHeader(accented)).not.toBe(accented);
  });

  it("leaves a plain ASCII name unchanged on the wire (logs stay readable)", () => {
    expect(encodeFilenameHeader("report.html")).toBe("report.html");
    expect(decodeFilenameHeader("report.html")).toBe("report.html");
  });

  it("rejects a raw, un-encoded value instead of guessing", () => {
    // A space and a `/` are both outside the encoder's alphabet.
    expect(decodeFilenameHeader("Nice Name.bin")).toBeNull();
    expect(decodeFilenameHeader("nested/report.md")).toBeNull();
    for (const name of NON_ASCII) expect(decodeFilenameHeader(name)).toBeNull();
  });

  it("rejects a malformed or invalid-UTF-8 escape", () => {
    expect(decodeFilenameHeader("%zz.md")).toBeNull();
    expect(decodeFilenameHeader("truncated%")).toBeNull();
    expect(decodeFilenameHeader("%E4%")).toBeNull();
    expect(decodeFilenameHeader("%FF.md")).toBeNull();
  });

  it("rejects an empty or over-long value", () => {
    expect(decodeFilenameHeader("")).toBeNull();
    // The bound is internal; assert it behaviourally. 64K is far past any
    // ceiling a real name could need.
    expect(decodeFilenameHeader("a".repeat(65_536))).toBeNull();
    // …while a full-length name of 3-byte code points still decodes, so the
    // ceiling can never reject a name `sanitizeFilename` would accept.
    const longName = "报".repeat(MAX_FILENAME_LEN);
    expect(decodeFilenameHeader(encodeFilenameHeader(longName))).toBe(longName);
  });

  it("round-trips a name carrying `%` literally", () => {
    expect(decodeFilenameHeader(encodeFilenameHeader("100%-done.md"))).toBe("100%-done.md");
  });
});

describe("attachmentDisposition", () => {
  it("carries the real name in the RFC 8187 ext-value and a scrubbed ASCII fallback", () => {
    expect(attachmentDisposition("rapport-été.md")).toBe(
      "attachment; filename=\"rapport-_t_.md\"; filename*=UTF-8''rapport-%C3%A9t%C3%A9.md",
    );
  });

  it("percent-encodes the four characters `encodeURIComponent` leaves outside attr-char", () => {
    // `'` is the ext-value's own delimiter (RFC 8187 §3.2): charset and language
    // are the first two apostrophes, so a raw third one invites a parser to
    // split the value in the wrong place.
    expect(attachmentDisposition("don't (final)*.md")).toBe(
      "attachment; filename=\"don't (final)*.md\"; filename*=UTF-8''don%27t%20%28final%29%2A.md",
    );
  });

  it("keeps `!` raw — it IS in attr-char", () => {
    expect(attachmentDisposition("wow!.md")).toContain("filename*=UTF-8''wow!.md");
  });

  it("neutralises a quote or backslash in the ASCII fallback so the quoted-string cannot break out", () => {
    expect(attachmentDisposition('we"ird\\name.txt')).toBe(
      "attachment; filename=\"we_ird_name.txt\"; filename*=UTF-8''we%22ird%5Cname.txt",
    );
  });

  it("falls back to `download` only when the ASCII form is EMPTY, not merely scrubbed", () => {
    // A non-ASCII name still leaves one `_` per character, which is truthy — the
    // fallback is for an empty input, and the ext-value stays authoritative.
    expect(attachmentDisposition("中")).toBe(
      "attachment; filename=\"_\"; filename*=UTF-8''%E4%B8%AD",
    );
    expect(attachmentDisposition("")).toBe("attachment; filename=\"download\"; filename*=UTF-8''");
  });
});
