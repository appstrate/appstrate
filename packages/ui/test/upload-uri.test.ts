// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

// `FileWidget` classifies existing field values with `isUploadUri`, so these
// cases guard the contract the widget depends on. The implementation lives in
// `@appstrate/core` (the API side parses the same URIs); `packages/ui` used to
// carry a byte-identical copy and no longer does.
import { describe, it, expect } from "bun:test";
import { isUploadUri } from "@appstrate/core/file-uri";

describe("isUploadUri", () => {
  it("accepts valid upload:// strings", () => {
    expect(isUploadUri("upload://upl_abc")).toBe(true);
  });

  it("rejects other strings", () => {
    expect(isUploadUri("https://example.com/file")).toBe(false);
    expect(isUploadUri("")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isUploadUri(null)).toBe(false);
    expect(isUploadUri(undefined)).toBe(false);
    expect(isUploadUri(123)).toBe(false);
    expect(isUploadUri({})).toBe(false);
  });
});
