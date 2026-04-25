// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { asProviderCallBody, formatBytes } from "../provider-call-body-utils";

describe("formatBytes", () => {
  it("renders bytes under 1 KiB verbatim", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("renders KB with one decimal", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(4096)).toBe("4.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("renders MB with two decimals", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.00 MB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
  });

  it("renders GB with two decimals", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.00 GB");
  });

  it("falls back gracefully on negative or NaN input", () => {
    expect(formatBytes(-1)).toBe("-1 B");
    expect(formatBytes(NaN)).toBe("NaN B");
  });
});

describe("asProviderCallBody", () => {
  it("narrows valid text bodies", () => {
    expect(asProviderCallBody({ kind: "text", text: "hello" })).toEqual({
      kind: "text",
      text: "hello",
    });
  });

  it("narrows valid inline bodies", () => {
    const out = asProviderCallBody({
      kind: "inline",
      data: "aGVsbG8=",
      encoding: "base64",
      mimeType: "application/octet-stream",
      size: 5,
    });
    expect(out).toEqual({
      kind: "inline",
      data: "aGVsbG8=",
      encoding: "base64",
      mimeType: "application/octet-stream",
      size: 5,
    });
  });

  it("narrows valid file bodies", () => {
    const out = asProviderCallBody({
      kind: "file",
      path: "documents/report.pdf",
      size: 4096,
      mimeType: "application/pdf",
      sha256: "abc123def456789012",
    });
    expect(out).toEqual({
      kind: "file",
      path: "documents/report.pdf",
      size: 4096,
      mimeType: "application/pdf",
      sha256: "abc123def456789012",
    });
  });

  it("rejects malformed shapes (missing fields, wrong types, wrong encoding)", () => {
    expect(asProviderCallBody(null)).toBeNull();
    expect(asProviderCallBody(undefined)).toBeNull();
    expect(asProviderCallBody({})).toBeNull();
    expect(asProviderCallBody({ kind: "text" })).toBeNull(); // missing text
    expect(asProviderCallBody({ kind: "text", text: 42 })).toBeNull(); // wrong type
    expect(
      asProviderCallBody({
        kind: "inline",
        data: "x",
        encoding: "hex", // wrong encoding
        mimeType: "image/png",
        size: 1,
      }),
    ).toBeNull();
    expect(
      asProviderCallBody({
        kind: "file",
        path: "x",
        size: 1,
        mimeType: "image/png",
        // missing sha256
      }),
    ).toBeNull();
    expect(asProviderCallBody({ kind: "other", text: "x" })).toBeNull();
  });
});
