// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end wiring test for the container-runtime provider bridge.
 *
 * Exercises the exact flow entrypoint.ts now performs at boot:
 *   1. Loaded AFPS bundle with a `providers/` directory in memory.
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
import type { LoadedBundle } from "@appstrate/afps-runtime/bundle";
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
      logs.push({ method: req.method, url: new URL(req.url).pathname, headers, body });
      return respond(req);
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
  };
}

// ─── Bundle fixture ────────────────────────────────────────────────────

function makeBundle(providers: Record<string, string>): LoadedBundle {
  const manifest = {
    name: "test-agent",
    version: "1.0.0",
    dependencies: { providers },
  };
  const encoder = new TextEncoder();
  const files: Record<string, Uint8Array> = {
    "manifest.json": encoder.encode(JSON.stringify(manifest)),
    "prompt.md": encoder.encode("test"),
  };
  for (const name of Object.keys(providers)) {
    files[`providers/${name}/provider.json`] = encoder.encode(
      JSON.stringify({
        name,
        authorizedUris: ["https://api.example.com/**"],
      }),
    );
  }
  return {
    manifest,
    prompt: "test",
    files,
    compressedSize: 0,
    decompressedSize: 0,
  } as unknown as LoadedBundle;
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
    const resolver = new SidecarProviderResolver({
      sidecarUrl: sidecar.url,
      providerPrefix: "providers/",
    });

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

    // The bridge returns a single text content with the JSON-serialised
    // ProviderCallResponse. Parse to assert.
    const parsed = JSON.parse(result.content[0]!.text) as {
      status: number;
      body: { inline?: string };
    };
    expect(parsed.status).toBe(200);
    expect(parsed.body.inline).toContain("messages");

    // Sidecar saw the expected headers
    expect(sidecarLogs).toHaveLength(1);
    const hit = sidecarLogs[0]!;
    expect(hit.url).toBe("/proxy");
    expect(hit.headers["x-provider"]).toBe("@appstrate/gmail");
    expect(hit.headers["x-target"]).toBe("https://api.example.com/messages");

    // Provider lifecycle event surfaced
    expect(events.some((e) => e.type === "provider.called")).toBe(true);
  });

  it("enforces authorizedUris before dispatching to the sidecar", async () => {
    const bundle = makeBundle({ "@appstrate/gmail": "1.0.0" });
    const resolver = new SidecarProviderResolver({
      sidecarUrl: sidecar.url,
      providerPrefix: "providers/",
    });

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

    // Sidecar MUST NOT have been contacted for the rejected target.
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
