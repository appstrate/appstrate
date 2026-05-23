// SPDX-License-Identifier: Apache-2.0

/**
 * P4 — `runConnectOnce` ephemeral connect-run primitive — REAL spawned MCP
 * server e2e. The sidecar-side counterpart to the platform's connect-run
 * launcher.
 *
 * Drives `runConnectOnce` against the REAL `@appstrate/connect-tool-test`
 * fixture (pure-stdlib Python MCP server spawned through the process runtime
 * adapter, per-run CA + per-SNI MITM listener, mocked upstream). Asserts that
 * the ONE login run mints + RETURNS the captured CredentialBundle and that the
 * secret was substituted proxy-side (the upstream saw the real credentials
 * even though the tool was invoked with empty args).
 *
 * Mocked: the platform's `/internal/integration-bundle` + `/internal/
 * integration-credentials` (injected `fetchFn`); the upstream host (Bun.serve
 * via routed globalThis.fetch).
 *
 * Skipped when openssl or python3 are missing (process-mode requires both).
 */

import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { zipArtifact } from "@appstrate/core/zip";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import type { IntegrationCredentialsWire } from "@appstrate/connect/integration-credentials";
import { runConnectOnce } from "../integrations-boot.ts";

async function toolAvailable(cmd: string[]): Promise<boolean> {
  try {
    const proc = (
      globalThis as unknown as {
        Bun?: { spawn: (args: string[], opts: object) => { exited: Promise<number> } };
      }
    ).Bun?.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
    if (!proc) return false;
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

const HAS_OPENSSL = await toolAvailable(["openssl", "version"]);
const HAS_PYTHON = await toolAvailable(["python3", "--version"]);
const RUNNABLE = HAS_OPENSSL && HAS_PYTHON;
if (!RUNNABLE) {
  console.warn(
    `[run-connect-once-e2e] skipped — openssl=${HAS_OPENSSL} python3=${HAS_PYTHON} (both required)`,
  );
}
const runE2e: typeof it = RUNNABLE ? it : (it.skip as unknown as typeof it);

const FIXTURE_DIR = path.join(
  import.meta.dir,
  "../../../scripts/system-packages/integration-connect-tool-test-1.0.0",
);
const INTEG_ID = "@appstrate/connect-tool-test";
const NAMESPACE = "connecttooltest";
const UPSTREAM_HOST = "connecttool.test.appstrate.dev";
const AUTHORIZED_URIS = [`https://${UPSTREAM_HOST}/**`];

const REAL_EMAIL = "agent@orga.example";
const REAL_PASSWORD = "sup3r-s3cret-pw";

function fixtureBundleBytes(): Uint8Array {
  const manifest = readFileSync(path.join(FIXTURE_DIR, "manifest.json"));
  const server = readFileSync(path.join(FIXTURE_DIR, "server.py"));
  return zipArtifact({
    "manifest.json": new Uint8Array(manifest),
    "server.py": new Uint8Array(server),
  });
}

function placeholderWire(): IntegrationCredentialsWire {
  return {
    auths: [
      { authKey: "session", authType: "custom", fields: {}, authorizedUris: AUTHORIZED_URIS },
    ],
    deliveryPlans: {
      session: {
        headerName: "Authorization",
        headerPrefix: "Bearer ",
        value: "",
        allowServerOverride: false,
      },
    },
    expiresAtEpochMs: { session: null },
  };
}

function spec(): IntegrationSpawnSpec {
  return {
    integrationId: INTEG_ID,
    namespace: NAMESPACE,
    manifest: {
      name: INTEG_ID,
      version: "1.0.0",
      server: { type: "python", entryPoint: "./server.py" },
    },
    spawnEnv: {},
    toolAllowlist: [],
    httpDeliveryAuths: {
      session: {
        authType: "custom",
        headerName: "Authorization",
        headerPrefix: "Bearer ",
        value: "",
        allowServerOverride: false,
        authorizedUris: AUTHORIZED_URIS,
      },
    },
    connectLogin: {
      toolName: "login",
      produces: ["session_token"],
      authKey: "session",
      authType: "custom",
      authorizedUris: AUTHORIZED_URIS,
      deliveryHttp: {
        headerName: "Authorization",
        headerPrefix: "Bearer ",
        valueFrom: "session_token",
      },
      inputs: { email: REAL_EMAIL, password: REAL_PASSWORD },
      reauthOn: [401],
    },
  };
}

function makePlatformFetch(): typeof fetch {
  const bundle = fixtureBundleBytes();
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/internal/integration-bundle/")) {
      return new Response(bundle, { status: 200 });
    }
    if (url.includes("/internal/integration-credentials/")) {
      return new Response(JSON.stringify(placeholderWire()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ detail: `unexpected platform call: ${url}` }), {
      status: 404,
    });
  }) as unknown as typeof fetch;
}

interface UpstreamHandle {
  obs: { loginUsername: string | null; loginPassword: string | null; loginHits: number };
  restore(): void;
}

function installUpstream(): UpstreamHandle {
  const obs = {
    loginUsername: null as string | null,
    loginPassword: null as string | null,
    loginHits: 0,
  };
  let tokenCounter = 0;
  const originalFetch = globalThis.fetch;

  const handle = async (url: URL, init?: RequestInit): Promise<Response> => {
    if (url.pathname === "/csrf") {
      return new Response(JSON.stringify({ csrf: "csrf-token-123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/login") {
      obs.loginHits += 1;
      const params = new URLSearchParams(init?.body ? String(init.body) : "");
      obs.loginUsername = params.get("username");
      obs.loginPassword = params.get("password");
      tokenCounter += 1;
      return new Response(JSON.stringify({ session_token: `sess-${tokenCounter}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let parsed: URL | null;
    try {
      parsed = new URL(raw);
    } catch {
      parsed = null;
    }
    if (parsed && parsed.hostname === UPSTREAM_HOST) {
      if (input instanceof Request && !init) {
        const body =
          input.method === "GET" || input.method === "HEAD" ? undefined : await input.text();
        return handle(parsed, { method: input.method, headers: input.headers, body });
      }
      return handle(parsed, init);
    }
    return originalFetch(input as never, init);
  }) as unknown as typeof fetch;

  return {
    obs,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("runConnectOnce — real spawned python MCP server (P4 e2e)", () => {
  runE2e(
    "runs login once, substitutes the secret proxy-side, and returns the captured bundle",
    async () => {
      const upstream = installUpstream();
      const platformFetch = makePlatformFetch();
      const prevAdapter = process.env.INTEGRATION_RUNTIME_ADAPTER;
      process.env.INTEGRATION_RUNTIME_ADAPTER = "process";

      try {
        const bundle = await runConnectOnce(spec(), {
          platformApiUrl: "http://platform.local",
          runToken: "run-tok-p4",
          fetchFn: platformFetch,
        });

        // The login ran exactly once and minted a session token.
        expect(upstream.obs.loginHits).toBe(1);
        expect(bundle.outputs.session_token).toBe("sess-1");
        // Substitution worked — the upstream saw the REAL credentials even
        // though the tool was invoked with empty args.
        expect(upstream.obs.loginUsername).toBe(REAL_EMAIL);
        expect(upstream.obs.loginPassword).toBe(REAL_PASSWORD);
      } finally {
        upstream.restore();
        if (prevAdapter === undefined) delete process.env.INTEGRATION_RUNTIME_ADAPTER;
        else process.env.INTEGRATION_RUNTIME_ADAPTER = prevAdapter;
      }
    },
    30_000,
  );

  it("throws when the spec has no connectLogin block", async () => {
    const noLogin = spec();
    delete noLogin.connectLogin;
    await expect(
      runConnectOnce(noLogin, { platformApiUrl: "http://x", runToken: "t" }),
    ).rejects.toThrow(/no connectLogin/);
  });
});
