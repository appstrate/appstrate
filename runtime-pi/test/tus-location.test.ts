// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * The tus `Location` of the Create response against an `api_upload` target that may hold
 * `{{field}}` placeholders: the adapter only sees the unrendered template, and the sidecar
 * renders placeholders in every target it is handed — the session URL included.
 */
import { describe, it, expect } from "bun:test";
import { tusAdapter } from "../mcp/upload-adapters/tus.ts";
import { UploadError, type AdapterContext } from "../mcp/upload-adapters/types.ts";

async function sessionUrl(target: string, location: string): Promise<string> {
  const ctx = {
    apiCallToolName: "x__api_call",
    target,
    totalBytes: 4,
    metadata: {},
    partSizeBytes: 4,
    apiCall: async () => ({ status: 201, headers: { location }, body: "" }),
    signal: new AbortController().signal,
    hashUpdate: () => {},
  } as AdapterContext;
  const state = (await tusAdapter.initSession(ctx)) as { sessionUrl: string };
  return state.sessionUrl;
}

describe("tus Location resolution", () => {
  it("resolves a relative Location against a literal target", async () => {
    expect(await sessionUrl("https://h.example/api/upload", "files/abc")).toBe(
      "https://h.example/api/files/abc",
    );
  });

  it("keeps an absolute Location as is under a templated target", async () => {
    expect(
      await sessionUrl("https://h.example/{{folder}}/upload", "https://s.example/files/abc"),
    ).toBe("https://s.example/files/abc");
    expect(await sessionUrl("{{site_url}}/upload", "https://s.example/files/abc")).toBe(
      "https://s.example/files/abc",
    );
  });

  it("resolves a path-absolute Location against a templated target's literal origin", async () => {
    expect(await sessionUrl("https://h.example/{{folder}}/upload", "/files/abc")).toBe(
      "https://h.example/files/abc",
    );
  });

  it("refuses a path-absolute Location under a base-URL placeholder (it may carry a path)", async () => {
    await expect(sessionUrl("{{site_url}}/upload", "/files/abc")).rejects.toThrow(
      /relative Location/,
    );
  });

  it("refuses a path-relative Location under a templated path", async () => {
    await expect(sessionUrl("https://h.example/{{folder}}/upload", "abc")).rejects.toThrow(
      /relative Location/,
    );
  });

  it("refuses a Location holding '{{', which the sidecar would substitute", async () => {
    for (const [target, location] of [
      ["https://h.example/upload", "/files/abc?k={{api_key}}"],
      ["https://h.example/upload", "https://h.example/files/{{ api_key }}"],
      ["https://h.example/{{folder}}/upload", "https://s.example/files?k={{api_key}}"],
    ] as const) {
      await expect(sessionUrl(target, location)).rejects.toThrow(
        /tus: Location header holds '\{\{'/,
      );
    }
  });

  it("refuses a Location that only holds '{{' once parsed (WHATWG strips tab/newline)", async () => {
    for (const [target, location] of [
      ["https://h.example/upload", "https://h.example/files/abc?k={\t{api_key}}"],
      ["https://h.example/upload", "/files?k={\n{api_key}}"],
      ["https://h.example/{{f}}/upload", "/files?k={\t{api_key}}"],
    ] as const) {
      await expect(sessionUrl(target, location)).rejects.toThrow(
        /tus: Location header holds '\{\{'/,
      );
    }
  });

  it("refuses a non-http(s) absolute Location", async () => {
    for (const location of ["javascript:alert(1)", "file:///etc/passwd"]) {
      await expect(sessionUrl("https://h.example/upload", location)).rejects.toThrow(
        /must be an http\(s\) URL/,
      );
    }
  });

  it("refuses an unparsable Location as an UploadError", async () => {
    for (const target of ["https://h.example/upload", "https://h.example/{{folder}}/upload"]) {
      const err = await sessionUrl(target, "http://[bad").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UploadError);
    }
  });

  it("resolves backslash and protocol-relative Locations per WHATWG under a templated path", async () => {
    const target = "https://h.example/{{folder}}/upload";
    expect(await sessionUrl(target, "\\files\\abc")).toBe("https://h.example/files/abc");
    expect(await sessionUrl(target, "//other.example/x")).toBe("https://other.example/x");
  });
});
