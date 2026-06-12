// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
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

describe("createS3Storage — createUploadUrl presign shape", () => {
  // getSignedUrl signs offline but needs credentials from the default provider
  // chain — inject fake ones for the duration of this suite.
  const savedEnv: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.AWS_ACCESS_KEY_ID = "test-access-key";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key";
    delete process.env.AWS_SESSION_TOKEN;
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("does not bind a checksum into the presigned URL (plain PUT must work)", async () => {
    const storage = createS3Storage({
      bucket: "test",
      region: "us-east-1",
      endpoint: "http://localhost:9000",
    });
    const { url } = await storage.createUploadUrl("uploads", "app/upl_1/file.pdf", {
      mime: "application/pdf",
    });
    const params = new URL(url).searchParams;
    // The SDK's WHEN_SUPPORTED default would sign `x-amz-checksum-crc32=AAAAAA==`
    // (CRC32 of the empty presign body) into the query, making S3 reject any
    // non-empty PUT that does not override it with the real checksum header.
    expect(params.get("x-amz-checksum-crc32")).toBeNull();
    expect(params.get("x-amz-sdk-checksum-algorithm")).toBeNull();
    expect(params.get("X-Amz-Signature")).not.toBeNull();
    // No declared size → content-length stays out of the signature.
    expect(params.get("X-Amz-SignedHeaders")).not.toContain("content-length");
  });

  it("signs Content-Length into the presigned PUT when a size is declared", async () => {
    const storage = createS3Storage({
      bucket: "test",
      region: "us-east-1",
      endpoint: "http://localhost:9000",
    });
    const descriptor = await storage.createUploadUrl("uploads", "app/upl_4/file.pdf", {
      mime: "application/pdf",
      maxSize: 24576,
    });
    const params = new URL(descriptor.url).searchParams;
    // content-length in X-Amz-SignedHeaders means S3 rejects any PUT whose
    // Content-Length differs from the declared size — a client cannot reserve
    // a small slot and upload an unbounded object.
    expect(params.get("X-Amz-SignedHeaders")).toContain("content-length");
    // The descriptor tells the client the exact byte count the signature binds.
    expect(descriptor.headers["Content-Length"]).toBe("24576");
    expect(descriptor.headers["Content-Type"]).toBe("application/pdf");
  });

  it("returns a PUT descriptor whose headers are sufficient for the upload", async () => {
    const storage = createS3Storage({
      bucket: "test",
      region: "us-east-1",
      endpoint: "http://localhost:9000",
    });
    const descriptor = await storage.createUploadUrl("uploads", "app/upl_2/data.csv", {
      mime: "text/csv",
      expiresIn: 120,
    });
    expect(descriptor.method).toBe("PUT");
    expect(descriptor.expiresIn).toBe(120);
    // The full header contract: clients send exactly these — nothing else
    // (no checksum headers) is required by the signature.
    expect(descriptor.headers).toEqual({ "Content-Type": "text/csv" });
  });

  it("presigns against the public endpoint when one is configured", async () => {
    const storage = createS3Storage({
      bucket: "test",
      region: "us-east-1",
      endpoint: "http://internal-minio:9000",
      publicEndpoint: "https://files.example.com",
    });
    const { url } = await storage.createUploadUrl("uploads", "app/upl_3/file.bin", {
      mime: "application/octet-stream",
    });
    expect(url.startsWith("https://files.example.com/")).toBe(true);
    expect(new URL(url).searchParams.get("x-amz-checksum-crc32")).toBeNull();
  });
});
