// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Phase 4 — Task 4.2 + 4.6:
 * Tests for the X-Auth-Refreshed retry consumer in
 * SidecarProviderResolver and RemoteAppstrateProviderResolver.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLE_FORMAT_VERSION,
  bundleIntegrity,
  computeRecordEntries,
  recordIntegrity,
  serializeRecord,
  type Bundle,
  type BundlePackage,
  type PackageIdentity,
} from "../../src/bundle/index.ts";
import {
  SidecarProviderResolver,
  RemoteAppstrateProviderResolver,
  type RunEvent,
  type ToolContext,
} from "../../src/resolvers/index.ts";

const enc = new TextEncoder();

function makePackage(
  name: `@${string}/${string}`,
  version: string,
  type: "agent" | "provider",
  files: Record<string, string>,
): BundlePackage {
  const identity = `${name}@${version}` as PackageIdentity;
  const manifest = { name, version, type };
  const filesMap = new Map<string, Uint8Array>();
  filesMap.set("manifest.json", enc.encode(JSON.stringify(manifest)));
  for (const [k, v] of Object.entries(files)) filesMap.set(k, enc.encode(v));
  const integrity = recordIntegrity(serializeRecord(computeRecordEntries(filesMap)));
  return { identity, manifest, files: filesMap, integrity };
}

function makeBundle(root: BundlePackage, deps: BundlePackage[] = []): Bundle {
  const packages = new Map<PackageIdentity, BundlePackage>();
  packages.set(root.identity, root);
  for (const d of deps) packages.set(d.identity, d);
  const pkgIndex = new Map<PackageIdentity, { path: string; integrity: string }>();
  for (const p of packages.values()) {
    pkgIndex.set(p.identity, {
      path: `packages/${(p.manifest as { name: string }).name}/${(p.manifest as { version: string }).version}/`,
      integrity: p.integrity,
    });
  }
  return {
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    root: root.identity,
    packages,
    integrity: bundleIntegrity(pkgIndex),
  };
}

function makeBundle_() {
  const root = makePackage("@acme/agent", "1.0.0", "agent", {});
  const provider = makePackage("@acme/p", "1.0.0", "provider", {
    "provider.json": JSON.stringify({ definition: { allowAllUris: true } }),
  });
  return makeBundle(root, [provider]);
}

function makeCtx(workspace: string, toolCallId = "tc_auth_refresh"): ToolContext {
  const ctrl = new AbortController();
  return {
    workspace,
    toolCallId,
    runId: "run_auth_refresh_test",
    signal: ctrl.signal,
    emit: (_e: RunEvent) => {},
  };
}

function makeSidecarResolver(fetchImpl: typeof fetch) {
  return new SidecarProviderResolver({
    sidecarUrl: "http://sidecar:8080",
    fetch: fetchImpl,
  });
}

function makeRemoteResolver(fetchImpl: typeof fetch) {
  return new RemoteAppstrateProviderResolver({
    instance: "http://platform:3000",
    apiKey: "ask_test",
    appId: "app_test",
    sessionId: "sess_test",
    fetch: fetchImpl,
  });
}

// ─── SidecarProviderResolver ─────────────────────────────────────────────────

describe("SidecarProviderResolver: X-Auth-Refreshed retry", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "afps-auth-refresh-sidecar-"));
  });

  afterAll(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {});
  });

  it("retries once with fromFile body when 401 + X-Auth-Refreshed: true", async () => {
    const payload = enc.encode("hello-file-body");
    const fileName = "body-file.txt";
    await writeFile(join(workspace, fileName), payload);

    let callCount = 0;
    const fetchImpl = (async (_url: string, _init: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "x-auth-refreshed": "true" },
        });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const resolver = makeSidecarResolver(fetchImpl);
    const tools = await resolver.resolve([{ name: "@acme/p", version: "^1" }], makeBundle_());
    const result = await tools[0]!.execute(
      {
        method: "POST",
        target: "https://api.example.com/upload",
        body: { fromFile: fileName },
      },
      makeCtx(workspace, "tc_sidecar_retry_file"),
    );

    expect(callCount).toBe(2);
    const parsed = JSON.parse(
      (result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { status: number };
    expect(parsed.status).toBe(200);
  });

  it("retries once with fromBytes body when 401 + X-Auth-Refreshed: true", async () => {
    const b64 = Buffer.from("binary-bytes-body").toString("base64");

    let callCount = 0;
    const fetchImpl = (async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "x-auth-refreshed": "true" },
        });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const resolver = makeSidecarResolver(fetchImpl);
    const tools = await resolver.resolve([{ name: "@acme/p", version: "^1" }], makeBundle_());
    const result = await tools[0]!.execute(
      {
        method: "POST",
        target: "https://api.example.com/upload",
        body: { fromBytes: b64, encoding: "base64" },
      },
      makeCtx(workspace, "tc_sidecar_retry_bytes"),
    );

    expect(callCount).toBe(2);
    const parsed = JSON.parse(
      (result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { status: number };
    expect(parsed.status).toBe(200);
  });

  it("does NOT retry when 401 WITHOUT X-Auth-Refreshed", async () => {
    let callCount = 0;
    const fetchImpl = (async () => {
      callCount++;
      return new Response("Unauthorized", { status: 401 });
    }) as unknown as typeof fetch;

    const resolver = makeSidecarResolver(fetchImpl);
    const tools = await resolver.resolve([{ name: "@acme/p", version: "^1" }], makeBundle_());
    await tools[0]!.execute(
      {
        method: "POST",
        target: "https://api.example.com/upload",
        body: "some-string-body",
      },
      makeCtx(workspace, "tc_sidecar_no_retry"),
    );

    // Only 1 call — no retry without the header
    expect(callCount).toBe(1);
  });

  it("does NOT retry a second time if retry also returns 401 + X-Auth-Refreshed (no infinite loop)", async () => {
    let callCount = 0;
    const fetchImpl = (async () => {
      callCount++;
      return new Response("Unauthorized", {
        status: 401,
        headers: { "x-auth-refreshed": "true" },
      });
    }) as unknown as typeof fetch;

    const resolver = makeSidecarResolver(fetchImpl);
    const tools = await resolver.resolve([{ name: "@acme/p", version: "^1" }], makeBundle_());
    const result = await tools[0]!.execute(
      {
        method: "POST",
        target: "https://api.example.com/upload",
        body: "string-body",
      },
      makeCtx(workspace, "tc_sidecar_no_inf_loop"),
    );

    // Exactly 2 calls: first attempt + one retry; no more
    expect(callCount).toBe(2);
    const parsed = JSON.parse(
      (result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { status: number };
    // The second 401 is returned as-is (no further retry)
    expect(parsed.status).toBe(401);
  });
});

// ─── RemoteAppstrateProviderResolver ─────────────────────────────────────────

describe("RemoteAppstrateProviderResolver: X-Auth-Refreshed retry", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "afps-auth-refresh-remote-"));
  });

  afterAll(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {});
  });

  it("retries once with fromFile body when 401 + X-Auth-Refreshed: true", async () => {
    const payload = enc.encode("remote-file-body");
    const fileName = "remote-body-file.txt";
    await writeFile(join(workspace, fileName), payload);

    let callCount = 0;
    const fetchImpl = (async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "x-auth-refreshed": "true" },
        });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const resolver = makeRemoteResolver(fetchImpl);
    const tools = await resolver.resolve([{ name: "@acme/p", version: "^1" }], makeBundle_());
    const result = await tools[0]!.execute(
      {
        method: "POST",
        target: "https://api.example.com/upload",
        body: { fromFile: fileName },
      },
      makeCtx(workspace, "tc_remote_retry_file"),
    );

    expect(callCount).toBe(2);
    const parsed = JSON.parse(
      (result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { status: number };
    expect(parsed.status).toBe(200);
  });

  it("retries once with fromBytes body when 401 + X-Auth-Refreshed: true", async () => {
    const b64 = Buffer.from("remote-binary-bytes").toString("base64");

    let callCount = 0;
    const fetchImpl = (async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "x-auth-refreshed": "true" },
        });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const resolver = makeRemoteResolver(fetchImpl);
    const tools = await resolver.resolve([{ name: "@acme/p", version: "^1" }], makeBundle_());
    const result = await tools[0]!.execute(
      {
        method: "POST",
        target: "https://api.example.com/upload",
        body: { fromBytes: b64, encoding: "base64" },
      },
      makeCtx(workspace, "tc_remote_retry_bytes"),
    );

    expect(callCount).toBe(2);
    const parsed = JSON.parse(
      (result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { status: number };
    expect(parsed.status).toBe(200);
  });

  it("does NOT retry when 401 WITHOUT X-Auth-Refreshed", async () => {
    let callCount = 0;
    const fetchImpl = (async () => {
      callCount++;
      return new Response("Unauthorized", { status: 401 });
    }) as unknown as typeof fetch;

    const resolver = makeRemoteResolver(fetchImpl);
    const tools = await resolver.resolve([{ name: "@acme/p", version: "^1" }], makeBundle_());
    await tools[0]!.execute(
      {
        method: "POST",
        target: "https://api.example.com/upload",
        body: "some-string-body",
      },
      makeCtx(workspace, "tc_remote_no_retry"),
    );

    expect(callCount).toBe(1);
  });

  it("does NOT retry a second time if retry also returns 401 (no infinite loop)", async () => {
    let callCount = 0;
    const fetchImpl = (async () => {
      callCount++;
      return new Response("Unauthorized", {
        status: 401,
        headers: { "x-auth-refreshed": "true" },
      });
    }) as unknown as typeof fetch;

    const resolver = makeRemoteResolver(fetchImpl);
    const tools = await resolver.resolve([{ name: "@acme/p", version: "^1" }], makeBundle_());
    const result = await tools[0]!.execute(
      {
        method: "POST",
        target: "https://api.example.com/upload",
        body: "string-body",
      },
      makeCtx(workspace, "tc_remote_no_inf_loop"),
    );

    expect(callCount).toBe(2);
    const parsed = JSON.parse(
      (result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { status: number };
    expect(parsed.status).toBe(401);
  });
});
