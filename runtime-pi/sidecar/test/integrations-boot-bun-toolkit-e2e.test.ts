// SPDX-License-Identifier: Apache-2.0

/**
 * Bun Toolkit reference integration — REAL spawned bun MCP server e2e.
 *
 * Boots the `@appstrate/bun-toolkit` dev fixture (a complex, multi-tool,
 * zero-dependency Bun MCP server, under `local-test-packages/`) through the full
 * `bootIntegrations` loop and exercises its Bun-native tools. Proves a
 * `server.type: "bun"` integration runs end-to-end — including that the
 * spawned process is long-lived (bun:sqlite state survives across separate
 * tool calls) and that it genuinely runs on Bun (system_info).
 *
 * Runs under `INTEGRATION_RUNTIME_ADAPTER=process`: bun integrations spawn as
 * host subprocesses via the process adapter (`HOST_INTERPRETER_BY_TYPE["bun"]`),
 * no Docker. In docker mode they'd instead use the `appstrate-mcp-runner-bun`
 * container — same MCP wire, validated by the docker adapter's own tests. The
 * spec is built directly (server-only: no api_call deps, no MITM) so the test
 * needs neither a platform DB nor openssl.
 */

import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { zipArtifact } from "@appstrate/core/zip";
import { validateManifest } from "@appstrate/core/validation";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import { bootIntegrations } from "../integrations-boot.ts";

const FIXTURE_DIR = path.join(
  import.meta.dir,
  "../../../local-test-packages/scripts/system-packages/integration-bun-toolkit-1.0.0",
);
const INTEG_ID = "@appstrate/bun-toolkit";
const NAMESPACE = "buntoolkit";

function fixtureBundleBytes(): Uint8Array {
  return zipArtifact({
    "manifest.json": new Uint8Array(readFileSync(path.join(FIXTURE_DIR, "manifest.json"))),
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
      server: { type: "bun", entryPoint: "./server.ts" },
    },
    spawnEnv: {},
    // Native-tool subset under test (api_call / fetch_echo need creds + MITM).
    toolAllowlist: ["kv_set", "kv_get", "kv_list", "hash", "uuid", "system_info"],
  };
}

function makePlatformFetch(): typeof fetch {
  const bundle = fixtureBundleBytes();
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/internal/integration-bundle/")) {
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

describe("@appstrate/bun-toolkit manifest", () => {
  it("validates as a server.type=bun integration with auth + apiCall + tool metadata", () => {
    const raw = readFileSync(path.join(FIXTURE_DIR, "manifest.json"), "utf-8");
    const result = validateManifest(JSON.parse(raw));
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error(result.errors.join(", "));

    const m = result.manifest as unknown as {
      server: { type: string; entryPoint: string };
      apiCall: { authKey: string };
      auths: Record<string, { type: string; delivery: { http: { headerName: string } } }>;
      tools: Record<string, { requiredScopes?: string[] }>;
    };
    expect(m.server.type).toBe("bun");
    expect(m.apiCall.authKey).toBe("primary");
    expect(m.auths.primary.type).toBe("api_key");
    expect(m.auths.primary.delivery.http.headerName).toBe("X-Toolkit-Token");
    expect(m.tools.fetch_echo.requiredScopes).toEqual(["read"]);
  });
});
