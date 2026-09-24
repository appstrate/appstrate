// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `fetchBundleForRun` — in-memory bundle download with
 * SRI verification. Uses a stubbed `fetch` implementation so each
 * scenario stays hermetic (no real instance, no real network).
 */

import { describe, it, expect } from "bun:test";

import { fetchBundleForRun, BundleFetchError } from "../src/commands/run/bundle-fetch.ts";

const FAKE_BUNDLE_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const FAKE_BUNDLE_SRI = sriOf(FAKE_BUNDLE_BYTES);

function sriOf(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return `sha256-${hasher.digest("base64")}`;
}

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
  it("returns the verified bytes and metadata", async () => {
    const capture: { url?: string; headers?: Headers } = {};
    const fetchImpl = stubFetch({
      headers: {
        "X-Bundle-Integrity": FAKE_BUNDLE_SRI,
        "X-Bundle-Version": "1.0.0",
        "Content-Disposition": 'attachment; filename="system-hello.afps-bundle.zip"',
      },
      capture,
    });
    const result = await fetchBundleForRun({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      spaceId: "spc_1",
      orgId: "org_1",
      packageId: "@system/hello",
      spec: undefined,
      fetchImpl,
    });

    expect(result.integrity).toBe(FAKE_BUNDLE_SRI);
    expect(result.bytes).toEqual(FAKE_BUNDLE_BYTES);
    // The CLI propagates the resolved version + source into the
    // `kind: "registry"` body it posts to /api/runs/remote.
    // Without this, attribution would have to fall back to fingerprint
    // reconciliation server-side.
    expect(result.version).toBe("1.0.0");
    expect(result.stage).toBe("published");

    // Literal `@` — encodeURIComponent would produce `%40system`, which the
    // Hono server route `:scope{@[^/]+}` rejects as 404. The CLI's URL
    // builder leaves scope/name unencoded (they're regex-validated to a
    // strict charset upstream).
    //
    // No `source` query at all: an id nobody put a spec on runs the latest
    // published version, like every other surface. Pin the absence — the
    // working copy belongs to whoever can write the package, and reaching
    // it by default is exactly the drift this asserts against.
    expect(capture.url).toBe("https://app.example.com/api/agents/@system/hello/bundle");
    expect(capture.headers?.get("Authorization")).toBe("Bearer ask_test");
    expect(capture.headers?.get("X-Space-Id")).toBe("spc_1");
    expect(capture.headers?.get("X-Org-Id")).toBe("org_1");
  });

  it("asks for the draft only when the caller spelled `@draft`", async () => {
    const capture: { url?: string; headers?: Headers } = {};
    const fetchImpl = stubFetch({
      headers: { "X-Bundle-Integrity": FAKE_BUNDLE_SRI, "X-Bundle-Version": "draft" },
      capture,
    });
    const result = await fetchBundleForRun({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      spaceId: "spc_1",
      packageId: "@scope/agent",
      spec: "draft",
      fetchImpl,
    });
    // `draft` is a reserved selector, not a dist-tag: it travels as
    // `?source=`, never as `?version=` (which resolves semver/ranges/tags).
    expect(capture.url).toBe("https://app.example.com/api/agents/@scope/agent/bundle?source=draft");
    expect(result.stage).toBe("draft");
    expect(result.version).toBe("draft");
  });

  it("spells `@published` as the explicit published source", async () => {
    const capture: { url?: string; headers?: Headers } = {};
    const fetchImpl = stubFetch({
      headers: { "X-Bundle-Integrity": FAKE_BUNDLE_SRI, "X-Bundle-Version": "2.0.0" },
      capture,
    });
    const result = await fetchBundleForRun({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      spaceId: "spc_1",
      packageId: "@scope/agent",
      spec: "published",
      fetchImpl,
    });
    expect(capture.url).toBe(
      "https://app.example.com/api/agents/@scope/agent/bundle?source=published",
    );
    expect(result.stage).toBe("published");
  });

  it("threads the spec into the version query parameter", async () => {
    const capture: { url?: string; headers?: Headers } = {};
    const fetchImpl = stubFetch({
      headers: { "X-Bundle-Integrity": FAKE_BUNDLE_SRI, "X-Bundle-Version": "1.2.3" },
      capture,
    });
    const result = await fetchBundleForRun({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      spaceId: "spc_1",
      packageId: "@scope/agent",
      spec: "^1.2",
      fetchImpl,
    });
    expect(capture.url).toContain("?version=%5E1.2");
    // Spec means `source: "published"` — even though the CLI asked for a
    // range, the server resolved to a concrete semver in `X-Bundle-Version`.
    expect(result.stage).toBe("published");
    expect(result.version).toBe("1.2.3");
  });

  it("re-fetches on every call — no on-disk cache", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(FAKE_BUNDLE_BYTES, {
        status: 200,
        headers: new Headers({
          "X-Bundle-Integrity": FAKE_BUNDLE_SRI,
          "X-Bundle-Version": "1.0.0",
        }),
      });
    }) as unknown as typeof fetch;

    await fetchBundleForRun({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      spaceId: "spc_1",
      packageId: "@system/hello",
      spec: undefined,
      fetchImpl,
    });
    await fetchBundleForRun({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      spaceId: "spc_1",
      packageId: "@system/hello",
      spec: undefined,
      fetchImpl,
    });
    expect(calls).toBe(2);
  });
});

describe("fetchBundleForRun — integrity guards", () => {
  it("rejects a downloaded bundle whose bytes do not match the advertised integrity", async () => {
    // Server lies — the integrity header references a different payload
    // than the body we return. We must surface this as integrity_mismatch.
    const fetchImpl = stubFetch({
      headers: {
        "X-Bundle-Integrity": "sha256-this-is-not-the-right-hash=",
        "X-Bundle-Version": "draft",
      },
    });
    await expect(
      fetchBundleForRun({
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        spaceId: "spc_1",
        packageId: "@system/hello",
        spec: undefined,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "integrity_mismatch" });
  });

  it("rejects responses missing the integrity header", async () => {
    const fetchImpl = stubFetch({ headers: {} });
    await expect(
      fetchBundleForRun({
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        spaceId: "spc_1",
        packageId: "@system/hello",
        spec: undefined,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "integrity_mismatch" });
  });

  it("rejects responses missing the bundle version header", async () => {
    const fetchImpl = stubFetch({
      headers: { "X-Bundle-Integrity": FAKE_BUNDLE_SRI },
    });
    await expect(
      fetchBundleForRun({
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        spaceId: "spc_1",
        packageId: "@system/hello",
        spec: undefined,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "bundle_fetch_failed" });
  });
});

describe("fetchBundleForRun — errors", () => {
  it("maps 404 with no version spec to package_not_found", async () => {
    const fetchImpl = stubFetch({ status: 404, body: "not found" });
    await expect(
      fetchBundleForRun({
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        spaceId: "spc_1",
        packageId: "@system/missing",
        spec: undefined,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "BundleFetchError",
      code: "package_not_found",
    });
  });

  it("maps 404 `agent_not_active_in_space` to package_not_active_in_space with an activation hint", async () => {
    // The bundle route distinguishes "doesn't exist in org" from "exists
    // in org but not active in space" via the `code` field on the
    // problem+json body. The CLI surfaces a different message for each so
    // users hit "activate it" instead of "is the spelling right?".
    const fetchImpl = stubFetch({
      status: 404,
      body: JSON.stringify({
        type: "about:blank",
        title: "Agent Not Active",
        status: 404,
        code: "agent_not_active_in_space",
        detail: "Agent '@me/x' is placed in space 'spc_test' but not active there.",
      }),
    });
    await expect(
      fetchBundleForRun({
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        spaceId: "spc_test",
        packageId: "@me/x",
        spec: undefined,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "BundleFetchError",
      code: "package_not_active_in_space",
      hint: expect.stringContaining("/api/spaces/spc_test/packages"),
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
        spaceId: "spc_1",
        packageId: "@system/hello",
        spec: "9.9.9",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "version_not_found" });
  });

  it("maps 422 `version_artifact_unavailable` to a storage-fault error naming the version", async () => {
    // The version is published but its stored archive is unreadable: the
    // user did nothing wrong, so the CLI must not say "check the spelling".
    const fetchImpl = stubFetch({
      status: 422,
      statusText: "Unprocessable Content",
      body: JSON.stringify({
        type: "about:blank",
        title: "Version Artifact Unavailable",
        status: 422,
        code: "version_artifact_unavailable",
        detail: "The stored archive of version 1.2.3 is unreadable.",
      }),
    });
    let caught: unknown;
    try {
      await fetchBundleForRun({
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        spaceId: "spc_1",
        packageId: "@scope/agent",
        spec: "1.2.3",
        fetchImpl,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BundleFetchError);
    const err = caught as BundleFetchError;
    expect(err.code).toBe("version_artifact_unavailable");
    expect(err.message).toContain("@scope/agent@1.2.3");
    expect(err.message).toContain("unreadable");
    expect(err.hint).toContain("republish");
    expect(err.hint).toContain("appstrate run @scope/agent@draft --local");
  });

  it("keeps any other 422 on the generic bundle_fetch_failed path", async () => {
    const fetchImpl = stubFetch({
      status: 422,
      statusText: "Unprocessable Content",
      body: JSON.stringify({ status: 422, code: "invalid_spec", detail: "bad spec" }),
    });
    await expect(
      fetchBundleForRun({
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        spaceId: "spc_1",
        packageId: "@scope/agent",
        spec: undefined,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      code: "bundle_fetch_failed",
      message: expect.stringContaining("HTTP 422"),
    });
  });

  it("maps 5xx to bundle_fetch_failed", async () => {
    const fetchImpl = stubFetch({ status: 502, statusText: "Bad Gateway", body: "upstream" });
    await expect(
      fetchBundleForRun({
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        spaceId: "spc_1",
        packageId: "@system/hello",
        spec: undefined,
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
        spaceId: "spc_1",
        packageId: "@system/missing",
        spec: undefined,
        fetchImpl,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BundleFetchError);
  });
});
