// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for storage adapters.
 *
 * Verifies that the storage layer (S3 or filesystem) works correctly
 * through the real factory in packages/db/src/storage.ts.
 *
 * When S3_BUCKET is set: tests run against S3/MinIO.
 * When S3_BUCKET is absent: tests run against local filesystem.
 */

import { describe, it, expect } from "bun:test";
import { uploadFile, downloadFile, deleteFile, ensureBucket } from "@appstrate/db/storage";
import { hasS3 } from "../../../src/infra/mode.ts";

const mode = hasS3() ? "S3" : "filesystem";
const TEST_BUCKET = "test-integration";

describe(`Storage (${mode})`, () => {
  it("ensureBucket does not throw", async () => {
    await ensureBucket();
  });

  it("upload and download round-trips binary data", async () => {
    const data = new Uint8Array([0, 1, 2, 42, 255, 128]);
    await uploadFile(TEST_BUCKET, "test-binary.bin", data);
    const result = await downloadFile(TEST_BUCKET, "test-binary.bin");
    expect(result).toEqual(data);
    await deleteFile(TEST_BUCKET, "test-binary.bin");
  });

  it("upload and download round-trips text data", async () => {
    const content = "Hello, storage integration test!";
    await uploadFile(TEST_BUCKET, "test-text.txt", Buffer.from(content));
    const result = await downloadFile(TEST_BUCKET, "test-text.txt");
    expect(new TextDecoder().decode(result!)).toBe(content);
    await deleteFile(TEST_BUCKET, "test-text.txt");
  });

  it("download returns null for missing files", async () => {
    const result = await downloadFile(TEST_BUCKET, "nonexistent-file.txt");
    expect(result).toBeNull();
  });

  it("delete is idempotent for missing files", async () => {
    // Should not throw
    await deleteFile(TEST_BUCKET, "never-existed.txt");
  });

  it("handles nested paths", async () => {
    const data = Buffer.from("nested content");
    await uploadFile(TEST_BUCKET, "a/b/c/deep.txt", data);
    const result = await downloadFile(TEST_BUCKET, "a/b/c/deep.txt");
    expect(new TextDecoder().decode(result!)).toBe("nested content");
    await deleteFile(TEST_BUCKET, "a/b/c/deep.txt");
  });

  it("overwrites existing files", async () => {
    await uploadFile(TEST_BUCKET, "overwrite.txt", Buffer.from("v1"));
    await uploadFile(TEST_BUCKET, "overwrite.txt", Buffer.from("v2"));
    const result = await downloadFile(TEST_BUCKET, "overwrite.txt");
    expect(new TextDecoder().decode(result!)).toBe("v2");
    await deleteFile(TEST_BUCKET, "overwrite.txt");
  });

  it("handles large-ish files (100KB)", async () => {
    const data = new Uint8Array(100 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = i % 256;

    await uploadFile(TEST_BUCKET, "large-file.bin", data);
    const result = await downloadFile(TEST_BUCKET, "large-file.bin");
    expect(result!.length).toBe(data.length);
    expect(result![0]).toBe(0);
    expect(result![255]).toBe(255);
    expect(result![256]).toBe(0);
    await deleteFile(TEST_BUCKET, "large-file.bin");
  });
});
