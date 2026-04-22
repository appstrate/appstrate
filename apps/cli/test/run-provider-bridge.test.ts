// SPDX-License-Identifier: Apache-2.0

/**
 * CLI-side integration test: exercise the full
 *   buildResolver() → buildProviderExtensionFactories() → Pi tool chain
 * that `appstrate run` assembles for a bundle with `dependencies.providers`.
 *
 * The point is to pin the contract between the CLI and the `@appstrate/runner-pi`
 * bridge: a manifest-declared provider turns into a typed `<slug>_call` tool,
 * and the tool, when executed, resolves credentials via the chosen resolver
 * and produces a structured JSON payload the LLM can consume. Same surface
 * as the runtime container path.
 */

import { describe, it, expect, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
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
import { buildProviderExtensionFactories } from "@appstrate/runner-pi";
import { buildResolver } from "../src/commands/run/resolver.ts";

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})),
  );
});

async function scratchDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "appstrate-cli-bridge-"));
  tmpDirs.push(dir);
  return dir;
}

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

function makeBundle(providerName: `@${string}/${string}`): Bundle {
  const root = makePackage(
    "@test/agent",
    "1.0.0",
    "agent",
    {},
    {
      dependencies: { providers: { [providerName]: "1.0.0" } },
    },
  );
  const provider = makePackage(providerName, "1.0.0", "provider", {
    "provider.json": JSON.stringify({
      name: providerName,
      authorizedUris: ["https://api.example.com/**"],
    }),
  });
  const packages = new Map<PackageIdentity, BundlePackage>();
  packages.set(root.identity, root);
  packages.set(provider.identity, provider);
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

function makeFakePi(): {
  api: ExtensionAPI;
  tools: Array<{
    name: string;
    execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
  }>;
} {
  const tools: Array<{
    name: string;
    execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
  }> = [];
  return {
    api: {
      registerTool(tool: (typeof tools)[number]) {
        tools.push(tool);
      },
    } as unknown as ExtensionAPI,
    tools,
  };
}

describe("CLI run → provider bridge (end-to-end wiring)", () => {
  it("`--providers=local` produces a working `<slug>_call` tool that injects creds from the file", async () => {
    const dir = await scratchDir();
    const credsPath = path.join(dir, "creds.json");

    // LocalCredentialsFile shape: per-provider `fields` + optional `injection`.
    // authorizedUris live on the bundle's provider manifest (loaded by the resolver).
    await fs.writeFile(
      credsPath,
      JSON.stringify({
        version: 1,
        providers: {
          "@test/echo": {
            fields: { api_key: "sekret_123" },
            injection: { headerName: "X-Test-Auth", headerPrefix: "Bearer " },
          },
        },
      }),
    );

    // Patch fetch BEFORE constructing the resolver — LocalProviderResolver
    // captures `fetch` at construction time, so later swaps would miss.
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v;
      });
      calls.push({ url, headers });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const resolver = buildResolver("local", { credsFilePath: credsPath });
      const bundle = makeBundle("@test/echo");

      const factories = await buildProviderExtensionFactories({
        bundle,
        providerResolver: resolver,
        runId: "run_cli_test",
        workspace: dir,
        emitProvider: () => {},
      });

      expect(factories).toHaveLength(1);

      const { api, tools } = makeFakePi();
      for (const f of factories) f(api);
      expect(tools[0]!.name).toBe("test_echo_call");

      const result = (await tools[0]!.execute("tc_1", {
        method: "GET",
        target: "https://api.example.com/ping",
      })) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0]!.text) as {
        status: number;
        body: { inline?: string };
      };
      expect(parsed.status).toBe(200);
      expect(parsed.body.inline).toContain("ok");

      // Credential injection happened at the resolver — the upstream fetch
      // saw the header the manifest configured.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.headers["x-test-auth"]).toBe("Bearer sekret_123");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("`--providers=none` registers zero tools for any bundle", async () => {
    const resolver = buildResolver("none", null);
    const bundle = makeBundle("@test/echo");
    const factories = await buildProviderExtensionFactories({
      bundle,
      providerResolver: resolver,
      runId: "r",
      workspace: "/tmp",
      emitProvider: () => {},
    });
    expect(factories).toEqual([]);
  });
});
