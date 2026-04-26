// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `fetchBundleForRun` — content-addressed bundle download
 * + cache. Uses a stubbed `fetch` implementation so each scenario stays
 * hermetic (no real instance, no real network).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

import { fetchBundleForRun, BundleFetchError } from "../src/commands/run/bundle-fetch.ts";

const FAKE_BUNDLE_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const FAKE_BUNDLE_SRI = sriOf(FAKE_BUNDLE_BYTES);

function sriOf(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return `sha256-${hasher.digest("base64")}`;
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "appstrate-cli-bundle-fetch-"));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function stubFetch(opts: {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  capture?: { url?: string; headers?: Headers };
}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (opts.capture) {
      opts.capture.url = typeof input === "string" ? input : input.toString();
      opts.capture.headers = new Headers(init?.headers);
    }
    const headers = new Headers(opts.headers ?? {});
    return new Response(opts.body ?? FAKE_BUNDLE_BYTES, {
      status: opts.status ?? 200,
      statusText: opts.statusText ?? "OK",
      headers,
    });
  }) as unknown as typeof fetch;
}

describe("fetchBundleForRun — happy path", () => {
  it("writes the bundle to a content-addressed path and returns its metadata", async () => {
    const capture: { url?: string; headers?: Headers } = {};
    const fetchImpl = stubFetch({
      headers: {
        "X-Bundle-Integrity": FAKE_BUNDLE_SRI,
        "Content-Disposition": 'attachment; filename="system-hello.afps-bundle.zip"',
      },
      capture,
    });
    const result = await fetchBundleForRun({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      appId: "app_1",
      orgId: "org_1",
      packageId: "@system/hello",
      spec: undefined,
      cacheRoot: tmpRoot,
      fetchImpl,
    });

    expect(result.fromCache).toBe(false);
    expect(result.integrity).toBe(FAKE_BUNDLE_SRI);
    expect(existsSync(result.path)).toBe(true);
    // Hash-based scope/name segments — assert host + suffix only; the
    // collision-resistance test below proves distinct ids map to
    // distinct directories.
    expect(result.path).toContain("/bundles/app.example.com/");
    expect(result.path.endsWith(".afps-bundle")).toBe(true);

    expect(capture.url).toBe("https://app.example.com/api/agents/%40system/hello/bundle");
    expect(capture.headers?.get("Authorization")).toBe("Bearer ask_test");
    expect(capture.headers?.get("X-App-Id")).toBe("app_1");
    expect(capture.headers?.get("X-Org-Id")).toBe("org_1");
  });

  it("threads the spec into the version query parameter", async () => {
    const capture: { url?: string; headers?: Headers } = {};
    const fetchImpl = stubFetch({
      headers: { "X-Bundle-Integrity": FAKE_BUNDLE_SRI },
      capture,
    });
    await fetchBundleForRun({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      appId: "app_1",
      packageId: "@scope/agent",
      spec: "^1.2",
      cacheRoot: tmpRoot,
      fetchImpl,
    });
    expect(capture.url).toContain("?version=%5E1.2");
  });
});

describe("fetchBundleForRun — caching", () => {
  it("reuses the cached file on a second call with the same integrity", async () => {
    const headers = {
      "X-Bundle-Integrity": FAKE_BUNDLE_SRI,
      "Content-Disposition": 'attachment; filename="system-hello.afps-bundle.zip"',
    };
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(FAKE_BUNDLE_BYTES, {
        status: 200,
        headers: new Headers(headers),
      });
    }) as unknown as typeof fetch;

    const first = await fetchBundleForRun({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      appId: "app_1",
      packageId: "@system/hello",
      spec: undefined,
      cacheRoot: tmpRoot,
      fetchImpl,
    });
    expect(first.fromCache).toBe(false);

    const second = await fetchBundleForRun({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      appId: "app_1",
      packageId: "@system/hello",
      spec: undefined,
      cacheRoot: tmpRoot,
      fetchImpl,
    });
    // Cache hit reuses the existing file; the second fetch was still
    // made (the response body has to be read to inspect the integrity
    // header) but the cached file is preserved.
    expect(second.fromCache).toBe(true);
    expect(second.path).toBe(first.path);
    expect(calls).toBe(2);
  });

  it("--no-cache forces a re-write", async () => {
    const fetchImpl = stubFetch({ headers: { "X-Bundle-Integrity": FAKE_BUNDLE_SRI } });
    const first = await fetchBundleForRun({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      appId: "app_1",
      packageId: "@system/hello",
      spec: undefined,
      cacheRoot: tmpRoot,
      fetchImpl,
    });
    // Mutate the cached file so we can detect a re-write (timestamps
    // are unreliable on fast filesystems).
    await writeFile(first.path, "stale");

    const second = await fetchBundleForRun({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      appId: "app_1",
      packageId: "@system/hello",
      spec: undefined,
      cacheRoot: tmpRoot,
      noCache: true,
      fetchImpl,
    });
    expect(second.fromCache).toBe(false);
    const buf = await readFile(second.path);
    expect(buf.byteLength).toBeGreaterThan(0);
    expect(buf.toString()).not.toBe("stale");
  });
});

describe("fetchBundleForRun — integrity guards", () => {
  it("invalidates the cache when the bytes no longer match the integrity", async () => {
    const fetchImpl = stubFetch({ headers: { "X-Bundle-Integrity": FAKE_BUNDLE_SRI } });
    const first = await fetchBundleForRun({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      appId: "app_1",
      packageId: "@system/hello",
      spec: undefined,
      cacheRoot: tmpRoot,
      fetchImpl,
    });
    // Tamper with the on-disk bytes so the next call sees a poisoned
    // cache. The SRI re-verify must reject the file and refetch.
    await writeFile(first.path, "tampered");
    const logs: string[] = [];
    const second = await fetchBundleForRun({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      appId: "app_1",
      packageId: "@system/hello",
      spec: undefined,
      cacheRoot: tmpRoot,
      fetchImpl,
      onLog: (m) => logs.push(m),
    });
    expect(second.fromCache).toBe(false);
    expect(logs.some((l) => l.includes("invalidated"))).toBe(true);
    const buf = await readFile(second.path);
    expect(buf.toString()).not.toBe("tampered");
  });

  it("rejects a downloaded bundle whose bytes do not match the advertised integrity", async () => {
    // Server lies — the integrity header references a different payload
    // than the body we return. We must surface this as integrity_mismatch
    // instead of seeding the cache with corrupted bytes.
    const fetchImpl = stubFetch({
      headers: { "X-Bundle-Integrity": "sha256-this-is-not-the-right-hash=" },
    });
    await expect(
      fetchBundleForRun({
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        appId: "app_1",
        packageId: "@system/hello",
        spec: undefined,
        cacheRoot: tmpRoot,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "integrity_mismatch" });
  });

  it("hashes scope/name into distinct cache directories for collision-prone ids", async () => {
    const fetchImpl = stubFetch({ headers: { "X-Bundle-Integrity": FAKE_BUNDLE_SRI } });
    const dashed = await fetchBundleForRun({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      appId: "app_1",
      packageId: "@scope/name-with-dashes",
      spec: undefined,
      cacheRoot: tmpRoot,
      fetchImpl,
    });
    const underscored = await fetchBundleForRun({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      appId: "app_1",
      packageId: "@scope/name_with_dashes",
      spec: undefined,
      cacheRoot: tmpRoot,
      fetchImpl,
    });
    expect(dashed.path).not.toBe(underscored.path);
  });
});

describe("fetchBundleForRun — errors", () => {
  it("maps 404 with no version spec to package_not_found", async () => {
    const fetchImpl = stubFetch({ status: 404, body: "not found" });
    await expect(
      fetchBundleForRun({
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        appId: "app_1",
        packageId: "@system/missing",
        spec: undefined,
        cacheRoot: tmpRoot,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "BundleFetchError",
      code: "package_not_found",
    });
  });

  it("maps 404 with version body to version_not_found", async () => {
    const fetchImpl = stubFetch({
      status: 404,
      body: '{"detail":"version 9.9.9 not found"}',
    });
    await expect(
      fetchBundleForRun({
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        appId: "app_1",
        packageId: "@system/hello",
        spec: "9.9.9",
        cacheRoot: tmpRoot,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "version_not_found" });
  });

  it("rejects responses missing the integrity header", async () => {
    const fetchImpl = stubFetch({ headers: {} });
    await expect(
      fetchBundleForRun({
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        appId: "app_1",
        packageId: "@system/hello",
        spec: undefined,
        cacheRoot: tmpRoot,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "integrity_mismatch" });
  });

  it("maps 5xx to bundle_fetch_failed", async () => {
    const fetchImpl = stubFetch({ status: 502, statusText: "Bad Gateway", body: "upstream" });
    await expect(
      fetchBundleForRun({
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        appId: "app_1",
        packageId: "@system/hello",
        spec: undefined,
        cacheRoot: tmpRoot,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "bundle_fetch_failed" });
  });

  it("BundleFetchError is the exported class", async () => {
    const fetchImpl = stubFetch({ status: 404 });
    let caught: unknown;
    try {
      await fetchBundleForRun({
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        appId: "app_1",
        packageId: "@system/missing",
        spec: undefined,
        cacheRoot: tmpRoot,
        fetchImpl,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BundleFetchError);
  });
});

it("isolates the cache by instance host", async () => {
  // Suppress unused warning — placeholder so the comment-only describe
  // block doesn't drift outside the file. The actual assertion lives
  // below and is a quick sanity check on the directory layout.
  const fetchImpl = stubFetch({ headers: { "X-Bundle-Integrity": FAKE_BUNDLE_SRI } });
  const a = await fetchBundleForRun({
    instance: "https://a.example.com",
    bearerToken: "ask_test",
    appId: "app_1",
    packageId: "@system/hello",
    spec: undefined,
    cacheRoot: tmpRoot,
    fetchImpl,
  });
  const b = await fetchBundleForRun({
    instance: "https://b.example.com",
    bearerToken: "ask_test",
    appId: "app_1",
    packageId: "@system/hello",
    spec: undefined,
    cacheRoot: tmpRoot,
    fetchImpl,
  });
  expect(a.path).not.toBe(b.path);
  expect(a.path).toContain("a.example.com");
  expect(b.path).toContain("b.example.com");
  // Both files exist (cache is per-host).
  expect((await stat(a.path)).isFile()).toBe(true);
  expect((await stat(b.path)).isFile()).toBe(true);
});
