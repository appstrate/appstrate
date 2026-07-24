// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createS3Storage } from "../src/storage-s3.ts";
import { verifyFsUploadToken } from "../src/storage-fs.ts";

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
    expect(params.get("X-Amz-SignedHeaders")).toContain("if-none-match");
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
    expect(params.get("X-Amz-SignedHeaders")).toContain("if-none-match");
    // The descriptor tells the client the exact byte count the signature binds.
    expect(descriptor.headers["Content-Length"]).toBe("24576");
    expect(descriptor.headers["Content-Type"]).toBe("application/pdf");
    expect(descriptor.headers["If-None-Match"]).toBe("*");
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
    // The full header contract includes the create-only precondition that
    // makes the signed PUT non-replayable after its first success.
    expect(descriptor.headers).toEqual({
      "If-None-Match": "*",
      "Content-Type": "text/csv",
    });
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

describe("createS3Storage — proxy-upload mode (issue #829)", () => {
  const proxyConfig = {
    bucket: "test",
    region: "us-east-1",
    endpoint: "http://internal-minio:9000",
    uploadBaseUrl: "https://app.example.com",
    uploadSecret: "proxy-test-secret",
  };

  it("signs an app-domain URL when no public endpoint is configured", async () => {
    const storage = createS3Storage(proxyConfig);
    const descriptor = await storage.createUploadUrl("uploads", "app_1/upl_1/file.pdf", {
      mime: "application/pdf",
      maxSize: 123,
      expiresIn: 600,
    });
    expect(descriptor.url.startsWith("https://app.example.com/api/uploads/_content?token=")).toBe(
      true,
    );
    expect(descriptor.method).toBe("PUT");
    expect(descriptor.expiresIn).toBe(600);
    // Proxy mode has no presigned Content-Length contract — the sink enforces
    // the signed max while streaming, so only Content-Type is echoed.
    expect(descriptor.headers).toEqual({ "Content-Type": "application/pdf" });
    // The token is verifiable with the same keyring the sink uses and binds
    // the storage key, size ceiling, and MIME.
    const token = new URL(descriptor.url).searchParams.get("token")!;
    const payload = verifyFsUploadToken(token, "proxy-test-secret");
    expect(payload).not.toBeNull();
    expect(payload!.k).toBe("uploads/app_1/upl_1/file.pdf");
    expect(payload!.s).toBe(123);
    expect(payload!.m).toBe("application/pdf");
  });

  it("trims trailing slashes off the upload base URL", async () => {
    const storage = createS3Storage({ ...proxyConfig, uploadBaseUrl: "https://app.example.com//" });
    const { url } = await storage.createUploadUrl("uploads", "a/b.bin");
    expect(url.startsWith("https://app.example.com/api/uploads/_content?token=")).toBe(true);
  });

  it("still rejects path traversal before signing", async () => {
    const storage = createS3Storage(proxyConfig);
    await expect(storage.createUploadUrl("uploads", "../escape.bin")).rejects.toThrow(
      "Path traversal detected",
    );
  });

  it("S3_PUBLIC_ENDPOINT-style config wins: presigns direct-to-bucket even with proxy config present", async () => {
    // Credentials for offline presign (same trick as the presign-shape suite).
    const saved = {
      id: process.env.AWS_ACCESS_KEY_ID,
      secret: process.env.AWS_SECRET_ACCESS_KEY,
    };
    process.env.AWS_ACCESS_KEY_ID = "test-access-key";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key";
    try {
      const storage = createS3Storage({
        ...proxyConfig,
        publicEndpoint: "https://files.example.com",
      });
      const { url } = await storage.createUploadUrl("uploads", "app/upl_9/file.bin");
      expect(url.startsWith("https://files.example.com/")).toBe(true);
      expect(new URL(url).searchParams.get("X-Amz-Signature")).not.toBeNull();
    } finally {
      if (saved.id === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = saved.id;
      if (saved.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = saved.secret;
    }
  });
});
