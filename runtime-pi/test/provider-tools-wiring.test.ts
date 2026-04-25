// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end wiring test for the container-runtime provider bridge.
 *
 * Exercises the exact flow entrypoint.ts now performs at boot:
 *   1. Multi-package {@link Bundle} carrying a provider dep.
 *   2. Spin up a fake sidecar HTTP server.
 *   3. Build a `SidecarProviderResolver` pointing at it.
 *   4. `buildProviderExtensionFactories` → Pi extension factory list.
 *   5. Execute the registered `<provider>_call` tool and assert the
 *      request hits the sidecar with the expected X-Provider / X-Target
 *      headers and the tool result contains the upstream status/body.
 *
 * This is the integration boundary between runner-pi (bridge) and
 * afps-runtime (resolver). It does NOT boot the full entrypoint.ts —
 * that's a top-level script; here we verify the composable units line
 * up so the script's behaviour is derivable from passing units + a
 * trivial glue file.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  BUNDLE_FORMAT_VERSION,
  bundleIntegrity,
  computeRecordEntries,
  recordIntegrity,
  serializeRecord,
  type Bundle,
  type BundlePackage,
  type PackageIdentity,
} from "@appstrate/afps-runtime/bundle";
import { SidecarProviderResolver } from "@appstrate/afps-runtime/resolvers";
import { buildProviderExtensionFactories } from "@appstrate/runner-pi";

// ─── Fake sidecar ──────────────────────────────────────────────────────

interface SidecarLog {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

function startFakeSidecar(
  logs: SidecarLog[],
  respond: (req: Request) => Promise<Response> | Response,
): {
  url: string;
  stop: () => void;
} {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text();
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      logs.push({
        method: req.method,
        url: new URL(req.url).pathname,
        headers,
        body,
      });
      return respond(req);
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
  };
}

// ─── Bundle fixture ────────────────────────────────────────────────────

const enc = new TextEncoder();

function makePackage(
  name: `@${string}/${string}`,
  version: string,
  type: "agent" | "provider",
  files: Record<string, string>,
  extraManifest: Record<string, unknown> = {},
): BundlePackage {
  const identity = `${name}@${version}` as PackageIdentity;
  const manifest = { name, version, type, ...extraManifest };
  const filesMap = new Map<string, Uint8Array>();
  filesMap.set("manifest.json", enc.encode(JSON.stringify(manifest)));
  for (const [k, v] of Object.entries(files)) filesMap.set(k, enc.encode(v));
  const integrity = recordIntegrity(serializeRecord(computeRecordEntries(filesMap)));
  return { identity, manifest, files: filesMap, integrity };
}

function makeBundle(providers: Record<string, string>): Bundle {
  const root = makePackage(
    "@test/agent",
    "1.0.0",
    "agent",
    {},
    {
      dependencies: { providers },
    },
  );
  const packages = new Map<PackageIdentity, BundlePackage>();
  packages.set(root.identity, root);
  for (const name of Object.keys(providers)) {
    const pkg = makePackage(name as `@${string}/${string}`, "1.0.0", "provider", {
      "provider.json": JSON.stringify({
        name,
        definition: {
          authMode: "oauth2",
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer",
          authorizedUris: ["https://api.example.com/**"],
        },
      }),
    });
    packages.set(pkg.identity, pkg);
  }
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

function makeFakePi() {
  const tools: Array<{
    name: string;
    execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
  }> = [];
  const api = {
    registerTool(tool: (typeof tools)[number]) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;
  return { api, tools };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("runtime-pi provider wiring (SidecarProviderResolver → runner-pi bridge)", () => {
  let sidecarLogs: SidecarLog[];
  let sidecar: { url: string; stop: () => void };

  beforeAll(() => {
    sidecarLogs = [];
    sidecar = startFakeSidecar(
      sidecarLogs,
      () =>
        new Response(JSON.stringify({ messages: [{ id: "m1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
  });

  afterAll(() => {
    sidecar.stop();
  });

  it("registers one <provider>_call tool per manifest provider and proxies via the sidecar", async () => {
    const bundle = makeBundle({ "@appstrate/gmail": "1.0.0" });
    const resolver = new SidecarProviderResolver({ sidecarUrl: sidecar.url });

    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const factories = await buildProviderExtensionFactories({
      bundle,
      providerResolver: resolver,
      runId: "run_test",
      workspace: "/tmp/ws",
      emitProvider: (e) => events.push(e),
    });

    expect(factories).toHaveLength(1);

    const { api, tools } = makeFakePi();
    for (const f of factories) f(api);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("appstrate_gmail_call");

    const result = (await tools[0]!.execute("tc_1", {
      method: "GET",
      target: "https://api.example.com/messages",
    })) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0]!.text) as {
      status: number;
      body: { kind: string; text?: string };
    };
    expect(parsed.status).toBe(200);
    expect(parsed.body.kind).toBe("text");
    expect(parsed.body.text).toContain("messages");

    expect(sidecarLogs).toHaveLength(1);
    const hit = sidecarLogs[0]!;
    expect(hit.url).toBe("/proxy");
    expect(hit.headers["x-provider"]).toBe("@appstrate/gmail");
    expect(hit.headers["x-target"]).toBe("https://api.example.com/messages");

    expect(events.some((e) => e.type === "provider.called")).toBe(true);
  });

  it("enforces authorizedUris before dispatching to the sidecar", async () => {
    const bundle = makeBundle({ "@appstrate/gmail": "1.0.0" });
    const resolver = new SidecarProviderResolver({ sidecarUrl: sidecar.url });

    const before = sidecarLogs.length;
    const factories = await buildProviderExtensionFactories({
      bundle,
      providerResolver: resolver,
      runId: "run_test",
      workspace: "/tmp/ws",
      emitProvider: () => {},
    });
    const { api, tools } = makeFakePi();
    for (const f of factories) f(api);

    await expect(
      tools[0]!.execute("tc_1", {
        method: "GET",
        target: "https://evil.example.com/attack",
      }),
    ).rejects.toThrow(/authorizedUris/);

    expect(sidecarLogs.length).toBe(before);
  });

  it("returns [] when bundle declares no providers and does not touch the resolver", async () => {
    const bundle = makeBundle({});
    let resolveCalled = false;
    const resolver = {
      resolve: async () => {
        resolveCalled = true;
        return [];
      },
    };
    const factories = await buildProviderExtensionFactories({
      bundle,
      providerResolver: resolver,
      runId: "r",
      workspace: "/w",
      emitProvider: () => {},
    });
    expect(factories).toEqual([]);
    expect(resolveCalled).toBe(false);
  });
});
