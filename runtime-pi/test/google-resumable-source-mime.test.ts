// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Regression: the `X-Upload-Content-Type` header on the resumable init MUST
 * describe the SOURCE bytes, not the DESIRED (target) file type in
 * `metadata.mimeType`. Declaring a Google-native target type as the source
 * makes Drive reject the FIRST chunk with a 400 (validated against the live
 * Drive API), which broke every Markdown/HTML/CSV → Google-Doc conversion.
 */
import { describe, it, expect } from "bun:test";
import { googleResumableAdapter } from "../mcp/upload-adapters/google-resumable.ts";
import type { AdapterContext } from "../mcp/upload-adapters/types.ts";

function initWith(over: Partial<AdapterContext>): Promise<Record<string, string> | undefined> {
  let seen: Record<string, string> | undefined;
  const ctx = {
    apiCallToolName: "x__api_call",
    target: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
    totalBytes: 40,
    metadata: {},
    partSizeBytes: 256 * 1024,
    apiCall: async (req: { headers: Record<string, string> }) => {
      seen = req.headers;
      return { status: 200, headers: { location: "https://sess.example/upload/s1" }, body: "{}" };
    },
    signal: new AbortController().signal,
    hashUpdate: () => {},
    ...over,
  } as AdapterContext;
  return googleResumableAdapter.initSession(ctx).then(() => seen);
}

describe("google-resumable X-Upload-Content-Type (source vs target MIME)", () => {
  it("uses the explicit sourceMimeType (enables Drive conversion)", async () => {
    const h = await initWith({
      sourceMimeType: "text/markdown",
      metadata: { name: "x", mimeType: "application/vnd.google-apps.document" },
    });
    expect(h?.["X-Upload-Content-Type"]).toBe("text/markdown");
  });

  it("does NOT declare a Google-native target type as the source (the 400 bug)", async () => {
    const h = await initWith({
      metadata: { name: "x", mimeType: "application/vnd.google-apps.document" },
    });
    expect(h?.["X-Upload-Content-Type"]).toBeUndefined();
  });

  it("falls back to metadata.mimeType when it is a real (non-native) source type", async () => {
    const h = await initWith({ metadata: { name: "x", mimeType: "text/plain" } });
    expect(h?.["X-Upload-Content-Type"]).toBe("text/plain");
  });

  it("sets no source type when none is available", async () => {
    const h = await initWith({ metadata: { name: "x" } });
    expect(h?.["X-Upload-Content-Type"]).toBeUndefined();
  });
});
