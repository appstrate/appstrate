// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { validateUriAgainstRoots } from "../roots.ts";

describe("validateUriAgainstRoots — happy path", () => {
  it("accepts a file URI within a declared root", () => {
    const result = validateUriAgainstRoots("file:///workspace/inputs/email.txt", [
      { uri: "file:///workspace/inputs/" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("accepts an s3 URI within a declared root", () => {
    const result = validateUriAgainstRoots("s3://appstrate-runs/run-1/inputs/data.json", [
      { uri: "s3://appstrate-runs/run-1/" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("returns the matched root declaration on success", () => {
    const root = { uri: "s3://appstrate-runs/run-1/", name: "run-blobs" };
    const result = validateUriAgainstRoots("s3://appstrate-runs/run-1/x", [root]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.matched).toEqual(root);
  });

  it("treats roots without trailing slash as if they had one", () => {
    const result = validateUriAgainstRoots("s3://b/run-1/file", [{ uri: "s3://b/run-1" }]);
    expect(result.ok).toBe(true);
  });
});

describe("validateUriAgainstRoots — security rejections", () => {
  it("rejects a URI not in any declared root", () => {
    const result = validateUriAgainstRoots("file:///etc/passwd", [
      { uri: "file:///workspace/inputs/" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not within");
  });

  it("rejects URIs containing `..`", () => {
    const result = validateUriAgainstRoots("file:///workspace/inputs/../../etc/passwd", [
      { uri: "file:///workspace/inputs/" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("traversal");
  });

  it("rejects URIs containing percent-encoded traversal", () => {
    const result = validateUriAgainstRoots("file:///workspace/inputs/%2E%2E/passwd", [
      { uri: "file:///workspace/inputs/" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects URIs that almost match (path prefix without slash boundary)", () => {
    // Without the trailing-slash rule, "run-1" would also match "run-10".
    const result = validateUriAgainstRoots("s3://bucket/run-10/x", [{ uri: "s3://bucket/run-1/" }]);
    expect(result.ok).toBe(false);
  });

  it("rejects mismatched scheme (s3 URI vs file root)", () => {
    const result = validateUriAgainstRoots("s3://bucket/run-1/x", [
      { uri: "file:///bucket/run-1/" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects http(s) schemes outright", () => {
    const result = validateUriAgainstRoots("https://attacker.example/path", [
      { uri: "https://attacker.example/" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not allowed");
  });

  it("rejects empty / non-string uris", () => {
    expect(validateUriAgainstRoots("", []).ok).toBe(false);
    expect(validateUriAgainstRoots(undefined as unknown as string, []).ok).toBe(false);
  });

  it("rejects malformed URIs", () => {
    const result = validateUriAgainstRoots("not a url", [{ uri: "file:///x/" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/valid URL|traversal|allowed/);
  });

  it("rejects URIs with empty path segments (double slash)", () => {
    const result = validateUriAgainstRoots("s3://bucket//run-1/file", [{ uri: "s3://bucket/" }]);
    expect(result.ok).toBe(false);
  });
});

describe("validateUriAgainstRoots — robustness", () => {
  it("ignores malformed roots and falls through", () => {
    const result = validateUriAgainstRoots("file:///x/y", [
      { uri: "::not-a-url" },
      { uri: "file:///x/" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("returns the first matching root", () => {
    const a = { uri: "s3://b/", name: "broad" };
    const b = { uri: "s3://b/sub/", name: "narrow" };
    const result = validateUriAgainstRoots("s3://b/sub/x", [a, b]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.matched.name).toBe("broad");
  });
});
