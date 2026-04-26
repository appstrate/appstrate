// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { createS3Storage } from "../src/storage-s3.ts";

describe("createS3Storage", () => {
  const storage = createS3Storage({ bucket: "test", region: "us-east-1" });

  it("safePath rejects paths containing '..'", () => {
    expect(() => storage.safePath("bucket", "../outside")).toThrow("Path traversal detected");
    expect(() => storage.safePath("bucket", "../../etc/passwd")).toThrow("Path traversal detected");
    expect(() => storage.safePath("bucket", "foo/../bar")).toThrow("Path traversal detected");
  });

  it("safePath returns correct keys for valid paths", () => {
    expect(storage.safePath("bucket", "file.txt")).toBe("bucket/file.txt");
    expect(storage.safePath("bucket", "sub/dir/file.txt")).toBe("bucket/sub/dir/file.txt");
    expect(storage.safePath("my-bucket", "path/to/data.json")).toBe("my-bucket/path/to/data.json");
  });

  it("safePath normalizes duplicate slashes", () => {
    expect(storage.safePath("bucket", "//file.txt")).toBe("bucket/file.txt");
    expect(storage.safePath("bucket", "a///b//c.txt")).toBe("bucket/a/b/c.txt");
  });
});
