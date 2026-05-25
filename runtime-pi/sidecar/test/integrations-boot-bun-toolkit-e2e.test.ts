// SPDX-License-Identifier: Apache-2.0

/**
 * Bun Toolkit reference mcp-server — REAL spawned bun MCP server e2e.
 *
 * Boots the `@appstrate/bun-toolkit-server` dev fixture (a complex, multi-tool,
 * zero-dependency Bun MCP server, a versioned test fixture under
 * `./fixtures/bun-toolkit/`) through the full `bootIntegrations` loop and
 * exercises its Bun-native tools. Proves a local-source integration whose
 * referenced mcp-server runs end-to-end — including that the spawned process is
 * long-lived (bun:sqlite state survives across separate tool calls) and that it
 * genuinely runs on Bun (system_info).
 *
 * Runs under `INTEGRATION_RUNTIME_ADAPTER=process`: bun servers spawn as host
 * subprocesses via the process adapter (`HOST_INTERPRETER_BY_TYPE["bun"]`), no
 * Docker. The spec is built directly (server-only: no api_call deps, no MITM) so
 * the test needs neither a platform DB nor openssl.
 */

import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { zipArtifact } from "@appstrate/core/zip";
import { validateManifest } from "@appstrate/core/validation";
import { mcpServerManifestSchema } from "@appstrate/core/mcp-server";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import { bootIntegrations } from "../integrations-boot.ts";

const FIXTURE_DIR = path.join(import.meta.dir, "fixtures/bun-toolkit");
const INTEG_ID = "@appstrate/bun-toolkit";
const SERVER_ID = "@appstrate/bun-toolkit-server";
const NAMESPACE = "buntoolkit";

/** The mcp-server bundle the sidecar fetches + spawns (server code + MCPB manifest). */
function serverBundleBytes(): Uint8Array {
  return zipArtifact({
    "manifest.json": new Uint8Array(
      readFileSync(path.join(FIXTURE_DIR, "mcp-server.manifest.json")),
    ),
    "server.ts": new Uint8Array(readFileSync(path.join(FIXTURE_DIR, "server.ts"))),
  });
}

function spec(): IntegrationSpawnSpec {
  return {
    integrationId: INTEG_ID,
    namespace: NAMESPACE,
    manifest: {
      name: INTEG_ID,
      version: "1.0.0",
      // The process adapter runs `.ts` under bun (`HOST_INTERPRETER_BY_TYPE["bun"]`).
      // The MCPB manifest declares `node` (a valid MCPB type), but this synthetic
      // spec pins `bun` so the host subprocess runs the TypeScript entry directly.
      server: { type: "bun", entryPoint: "./server.ts", serverPackageId: SERVER_ID },
    },
    spawnEnv: {},
    // Native-tool subset under test (api_call / fetch_echo need creds + MITM).
    toolAllowlist: ["kv_set", "kv_get", "kv_list", "hash", "uuid", "system_info"],
  };
}

function makePlatformFetch(): typeof fetch {
  const bundle = serverBundleBytes();
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/internal/mcp-server-bundle/")) {
      return new Response(bundle, { status: 200 });
    }
    return new Response(JSON.stringify({ detail: `unexpected platform call: ${url}` }), {
      status: 404,
    });
  }) as unknown as typeof fetch;
}

async function call(
  boot: Awaited<ReturnType<typeof bootIntegrations>>,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const t = boot.tools.find((x) => x.descriptor.name === `${NAMESPACE}__${tool}`);
  expect(t).toBeDefined();
  const res = await t!.handler(args, {} as never);
  const text = (res.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

describe("@appstrate/bun-toolkit — complex bun integration (e2e)", () => {
  it("boots as a bun subprocess (process mode) and exercises Bun-native tools", async () => {
    const prevAdapter = process.env.INTEGRATION_RUNTIME_ADAPTER;
    process.env.INTEGRATION_RUNTIME_ADAPTER = "process";

    let boot: Awaited<ReturnType<typeof bootIntegrations>> | null = null;
    try {
      boot = await bootIntegrations([spec()], {
        platformApiUrl: "http://platform.local",
        runToken: "run-tok-toolkit",
        fetchFn: makePlatformFetch(),
      });

      expect(boot.failed).toEqual([]);
      expect(boot.spawned.length).toBe(1);

      // Boot report: healthy (ok), one declared integration, and a per-phase
      // trail the agent relays into the run log — the runtime-adapter line
      // plus this integration's spawn/connect breadcrumb.
      expect(boot.report.ok).toBe(true);
      expect(boot.report.declared).toBe(1);
      expect(boot.report.adapter).toBe("process");
      const messages = boot.report.breadcrumbs.map((b) => b.message);
      expect(messages.some((m) => m.startsWith("runtime adapter: process"))).toBe(true);
      expect(messages.some((m) => m.includes(spec().integrationId) && m.includes("ready"))).toBe(
        true,
      );

      // The allowlisted native tools are exposed (and only those).
      const names = boot.tools.map((t) => t.descriptor.name).filter((n) => n.startsWith(NAMESPACE));
      expect(names).toContain(`${NAMESPACE}__kv_set`);
      expect(names).toContain(`${NAMESPACE}__system_info`);
      expect(names).not.toContain(`${NAMESPACE}__fetch_echo`); // not in allowlist

      // It genuinely runs on Bun.
      const info = await call(boot, "system_info", {});
      expect(info.runtime).toBe("bun");
      expect(typeof info.bunVersion).toBe("string");

      // bun:sqlite state persists across SEPARATE tool calls → proves a single
      // long-lived subprocess, not a stateless invocation.
      expect(await call(boot, "kv_get", { key: "alpha" })).toMatchObject({ value: null });
      await call(boot, "kv_set", { key: "alpha", value: "one" });
      await call(boot, "kv_set", { key: "beta", value: "two" });
      expect(await call(boot, "kv_get", { key: "alpha" })).toMatchObject({ value: "one" });
      expect(await call(boot, "kv_list", {})).toMatchObject({ count: 2 });

      // Bun.CryptoHasher — known sha256("hello").
      expect(await call(boot, "hash", { input: "hello", algorithm: "sha256" })).toMatchObject({
        hex: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      });

      const uuids = (await call(boot, "uuid", { count: 3 })).uuids as string[];
      expect(uuids).toHaveLength(3);
    } finally {
      if (boot) await boot.shutdown();
      if (prevAdapter === undefined) delete process.env.INTEGRATION_RUNTIME_ADAPTER;
      else process.env.INTEGRATION_RUNTIME_ADAPTER = prevAdapter;
    }
  }, 30_000);
});

describe("@appstrate/bun-toolkit fixtures", () => {
  it("the integration manifest is a native AFPS 2.0 local-source integration", () => {
    const raw = readFileSync(path.join(FIXTURE_DIR, "manifest.json"), "utf-8");
    const result = validateManifest(JSON.parse(raw));
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error(result.errors.join(", "));

    const m = result.manifest as unknown as {
      source: { kind: string; server?: { name: string } };
      _meta?: Record<string, { auth_key?: string }>;
      auths: Record<
        string,
        { type: string; delivery: { http: { in: string; name: string; value: string } } }
      >;
      tools: Record<string, { required_scopes?: string[] }>;
    };
    expect(m.source.kind).toBe("local");
    expect(m.source.server?.name).toBe(SERVER_ID);
    expect(m._meta?.["dev.appstrate/api"]?.auth_key).toBe("primary");
    expect(m.auths.primary!.type).toBe("api_key");
    expect(m.auths.primary!.delivery.http.name).toBe("X-Toolkit-Token");
    expect(m.auths.primary!.delivery.http.value).toBe("{$credential.api_key}");
    expect(m.tools.fetch_echo!.required_scopes).toEqual(["read"]);
  });

  it("the mcp-server manifest is a valid MCPB manifest referencing the server code", () => {
    const raw = readFileSync(path.join(FIXTURE_DIR, "mcp-server.manifest.json"), "utf-8");
    const parsed = mcpServerManifestSchema.safeParse(JSON.parse(raw));
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    const mcp = parsed.data as unknown as {
      server: { type: string; entry_point: string };
      _meta: Record<string, { name?: string; type?: string }>;
    };
    expect(mcp.server.type).toBe("node");
    expect(mcp.server.entry_point).toBe("./server.ts");
    expect(mcp._meta["dev.afps/mcp-server"]?.name).toBe(SERVER_ID);
  });
});
