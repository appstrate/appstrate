// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the agent-side `api_call` body resolver: `{ fromFile }`
 * becomes `{ fromBytes, encoding: "base64" }` (path-safe, size-capped);
 * every other body shape passes through untouched.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApiCallBody, ApiCallBodyResolveError } from "../mcp/api-call-body-resolver.ts";

function freshWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "apicall-body-"));
}

function writeFile(ws: string, name: string, bytes: Uint8Array | string): void {
  writeFileSync(join(ws, name), bytes);
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("resolveApiCallBody", () => {
  it("passes through string / null / undefined bodies", async () => {
    const ws = freshWorkspace();
    expect(await resolveApiCallBody("hello", { workspace: ws })).toBe("hello");
    expect(await resolveApiCallBody(null, { workspace: ws })).toBe(null);
    expect(await resolveApiCallBody(undefined, { workspace: ws })).toBe(undefined);
  });

  it("passes through { fromBytes } and { multipart } bodies untouched", async () => {
    const ws = freshWorkspace();
    const fromBytes = { fromBytes: b64("x"), encoding: "base64" };
    expect(await resolveApiCallBody(fromBytes, { workspace: ws })).toEqual(fromBytes);
    const multipart = { multipart: [{ name: "f", value: "v" }] };
    expect(await resolveApiCallBody(multipart, { workspace: ws })).toEqual(multipart);
  });

  it("resolves { fromFile } to { fromBytes, encoding }", async () => {
    const ws = freshWorkspace();
    writeFile(ws, "payload.json", '{"a":1}');
    expect(await resolveApiCallBody({ fromFile: "payload.json" }, { workspace: ws })).toEqual({
      fromBytes: b64('{"a":1}'),
      encoding: "base64",
    });
  });

  it("rejects a { fromFile } body over the size cap", async () => {
    const ws = freshWorkspace();
    writeFile(ws, "big.bin", "0123456789ABCDEF"); // 16 bytes
    await expect(
      resolveApiCallBody({ fromFile: "big.bin" }, { workspace: ws, maxBytes: 8 }),
    ).rejects.toBeInstanceOf(ApiCallBodyResolveError);
  });

  it("rejects a missing file with a structured error", async () => {
    const ws = freshWorkspace();
    await expect(
      resolveApiCallBody({ fromFile: "nope.json" }, { workspace: ws }),
    ).rejects.toBeInstanceOf(ApiCallBodyResolveError);
  });

  it("refuses a symlinked fromFile (path-safety via resolveSafeFile)", async () => {
    const ws = freshWorkspace();
    // Dangling symlink: resolveSafePath leaves it unresolved (target ENOENT),
    // so resolveSafeFile's `lstat().isSymbolicLink()` gate refuses it before
    // any read — deterministic across platforms.
    symlinkSync("/appstrate-test-nonexistent-target", join(ws, "link.txt"));
    await expect(
      resolveApiCallBody({ fromFile: "link.txt" }, { workspace: ws }),
    ).rejects.toBeInstanceOf(ApiCallBodyResolveError);
  });

  it("refuses a fromFile that escapes the allowed roots", async () => {
    const ws = freshWorkspace();
    // Absolute path under neither the workspace nor `/tmp` (the only extra
    // allowed root) — rejected by containment regardless of existence, so
    // it is stable on Linux (`/tmp` tmpdir) and macOS (`/var/folders`).
    await expect(
      resolveApiCallBody(
        { fromFile: "/appstrate-test-nonexistent-root/secret.txt" },
        { workspace: ws },
      ),
    ).rejects.toBeInstanceOf(ApiCallBodyResolveError);
  });
});
