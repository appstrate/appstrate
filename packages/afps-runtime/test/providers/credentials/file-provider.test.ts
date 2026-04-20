// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialProvider } from "../../../src/providers/credentials/file-provider.ts";
import { AUTH_KINDS } from "../../../src/types/auth-kind.ts";

async function makeTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "afps-file-creds-"));
}

describe("FileCredentialProvider", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the stored entry for a provider", async () => {
    const path = join(dir, "creds.json");
    await writeFile(
      path,
      JSON.stringify({
        github: {
          credentials: { token: "ghp_xxx" },
          authorizedUris: ["https://api.github.com"],
          expiresAt: 1735689600000,
        },
      }),
    );

    const p = new FileCredentialProvider({ path });
    const res = await p.getCredentials("github");
    expect(res.credentials).toEqual({ token: "ghp_xxx" });
    expect(res.authorizedUris).toEqual(["https://api.github.com"]);
    expect(res.expiresAt).toBe(1735689600000);
    expect(res.allowAllUris).toBeUndefined();
  });

  it("surfaces allowAllUris when set", async () => {
    const path = join(dir, "creds.json");
    await writeFile(
      path,
      JSON.stringify({
        gmail: { credentials: { access_token: "ya29…" }, allowAllUris: true },
      }),
    );

    const p = new FileCredentialProvider({ path });
    const res = await p.getCredentials("gmail");
    expect(res.allowAllUris).toBe(true);
    expect(res.authorizedUris).toEqual([]);
  });

  it("returns a fresh credentials object (caller cannot mutate cache)", async () => {
    const path = join(dir, "creds.json");
    await writeFile(path, JSON.stringify({ p: { credentials: { a: "1" }, authorizedUris: [] } }));

    const p = new FileCredentialProvider({ path });
    const first = await p.getCredentials("p");
    first.credentials.a = "mutated";

    const second = await p.getCredentials("p");
    expect(second.credentials.a).toBe("1");
  });

  it("throws when the provider key is missing", async () => {
    const path = join(dir, "creds.json");
    await writeFile(path, JSON.stringify({ p: { credentials: { k: "v" } } }));

    const provider = new FileCredentialProvider({ path });
    await expect(provider.getCredentials("missing")).rejects.toThrow(/no credentials.*missing/);
  });

  it("throws when the entry has no credentials field", async () => {
    const path = join(dir, "creds.json");
    await writeFile(path, JSON.stringify({ p: { authorizedUris: ["x"] } }));

    const provider = new FileCredentialProvider({ path });
    await expect(provider.getCredentials("p")).rejects.toThrow(/no credentials field/);
  });

  it("throws on unreadable file", async () => {
    const p = new FileCredentialProvider({ path: join(dir, "does-not-exist.json") });
    await expect(p.getCredentials("anything")).rejects.toThrow(/cannot read/);
  });

  it("throws on malformed JSON", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "{not-json");
    const provider = new FileCredentialProvider({ path });
    await expect(provider.getCredentials("x")).rejects.toThrow(/invalid JSON/);
  });

  it("throws when the top-level JSON is not an object", async () => {
    const path = join(dir, "array.json");
    await writeFile(path, JSON.stringify(["not", "an", "object"]));
    const provider = new FileCredentialProvider({ path });
    await expect(provider.getCredentials("x")).rejects.toThrow(/JSON object/);
  });

  it("loads the file once and caches (two calls, one read)", async () => {
    const path = join(dir, "creds.json");
    await writeFile(path, JSON.stringify({ p: { credentials: { k: "v1" } } }));

    const provider = new FileCredentialProvider({ path });
    const first = await provider.getCredentials("p");
    // Rewriting the file after first access must NOT affect subsequent reads.
    await writeFile(path, JSON.stringify({ p: { credentials: { k: "v2" } } }));
    const second = await provider.getCredentials("p");
    expect(first.credentials.k).toBe("v1");
    expect(second.credentials.k).toBe("v1");
  });

  it("defaults supportedAuthKinds to all AUTH_KINDS", () => {
    const p = new FileCredentialProvider({ path: "/tmp/unused" });
    expect(p.supportedAuthKinds()).toEqual([...AUTH_KINDS]);
  });

  it("honors an override on supportedAuthKinds", () => {
    const p = new FileCredentialProvider({
      path: "/tmp/unused",
      supportedAuthKinds: ["oauth2_pkce_server"],
    });
    expect(p.supportedAuthKinds()).toEqual(["oauth2_pkce_server"]);
  });
});
