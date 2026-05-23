// SPDX-License-Identifier: Apache-2.0

/**
 * P1–P3 connect.tool (run-start) substrate — REAL spawned MCP server e2e.
 *
 * Unlike `integrations-boot-connect-login.test.ts` (FAKE in-process host),
 * this test drives the full `bootIntegrations` boot loop against the REAL
 * `@appstrate/connect-tool-test` fixture: a pure-stdlib Python MCP server
 * spawned through the process runtime adapter, with a per-run CA + per-SNI
 * MITM listener, against a mocked upstream.
 *
 * What is REAL here:
 *   - the Python `server.py` runs as an actual `python3` subprocess driven
 *     over MCP stdio (`bootIntegrations` → process adapter → SubprocessTransport);
 *   - the connect-login dance is a real two-step HTTPS exchange the Python
 *     process issues through `HTTPS_PROXY`, tunneled and TLS-intercepted by
 *     the real MITM listener with a minted leaf cert the process trusts via
 *     `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE`;
 *   - the `{{email}}`/`{{password}}` substitution + the `Authorization`
 *     header injection happen in the real listener, proxy-side;
 *   - the P3 reauth path re-runs the real `login` tool on a real upstream 401.
 *
 * What is mocked:
 *   - the platform's `/internal/integration-bundle` + `/internal/integration-
 *     credentials` endpoints (via an injected `fetchFn`) — there is no live
 *     Hono app in this harness;
 *   - the upstream `connecttool.test.appstrate.dev` host — a Bun.serve mock,
 *     reached by temporarily routing the listener's `globalThis.fetch` for
 *     that host to the local mock (everything else falls through).
 *
 * The IntegrationSpawnSpec is constructed directly (the run-start connect-
 * login spec shape that `resolveIntegrationSpawns` emits — see
 * `integration-spawn-resolver-connect-login.test.ts`). Building it here
 * keeps the test free of a DB-seeded platform while exercising the exact
 * sidecar boot path.
 *
 * Skipped when openssl or python3 are missing (process-mode requires both).
 */

import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { zipArtifact } from "@appstrate/core/zip";
import { validateManifest } from "@appstrate/core/validation";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import type { IntegrationCredentialsWire } from "@appstrate/connect/integration-credentials";
import { bootIntegrations } from "../integrations-boot.ts";

// ─────────────────────────────────────────────
// Environment probes
// ─────────────────────────────────────────────

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
    `[connect-tool-e2e] skipped — openssl=${HAS_OPENSSL} python3=${HAS_PYTHON} (both required)`,
  );
}
const runE2e: typeof it = RUNNABLE ? it : (it.skip as unknown as typeof it);

// ─────────────────────────────────────────────
// Fixture bundle (the real fixture dir, zipped on the fly)
// ─────────────────────────────────────────────

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

/**
 * The initial credentials payload the platform serves for a connect.tool
 * run-start integration: a MITM placeholder auth (empty value) so the
 * sidecar creates the listener + source. The real session is minted at boot
 * by `runConnectLoginHook` calling `setSessionOutputs`.
 */
function placeholderWire(): IntegrationCredentialsWire {
  return {
    auths: [
      {
        authKey: "session",
        authType: "custom",
        fields: {},
        authorizedUris: AUTHORIZED_URIS,
      },
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
    // The spawn resolver strips `login` from the allowlist; the agent only
    // ever selects `fetch_data`.
    toolAllowlist: ["fetch_data"],
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

/**
 * Platform-endpoint mock: serves the fixture bundle + the placeholder
 * credentials wire. Drives both `fetchBundleBytes` and
 * `fetchInitialIntegrationCredentials`.
 */
function makePlatformFetch(): typeof fetch {
  const bundle = fixtureBundleBytes();
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/internal/integration-bundle/")) {
      return new Response(bundle, { status: 200 });
    }
    if (url.includes("/internal/integration-credentials/")) {
      // The /refresh POST is never hit on this path (connect.tool re-login
      // runs the login tool, not the platform refresh endpoint).
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

// ─────────────────────────────────────────────
// Upstream mock — installed by routing globalThis.fetch for UPSTREAM_HOST
// to a real local Bun.serve. The MITM listener forwards via globalThis.fetch.
// ─────────────────────────────────────────────

interface UpstreamObservations {
  loginUsername: string | null;
  loginPassword: string | null;
  loginCsrf: string | null;
  dataAuthHeaders: string[];
  csrfHits: number;
  loginHits: number;
  dataHits: number;
}

interface UpstreamHandle {
  obs: UpstreamObservations;
  /** Make the NEXT /data call return 401 once (drives the P3 reauth path). */
  arm401Once(): void;
  restore(): void;
}

function installUpstream(): UpstreamHandle {
  const obs: UpstreamObservations = {
    loginUsername: null,
    loginPassword: null,
    loginCsrf: null,
    dataAuthHeaders: [],
    csrfHits: 0,
    loginHits: 0,
    dataHits: 0,
  };
  let pending401 = false;
  let tokenCounter = 0;

  const originalFetch = globalThis.fetch;

  const handle = async (url: URL, init?: RequestInit): Promise<Response> => {
    const pathName = url.pathname;
    if (pathName === "/csrf") {
      obs.csrfHits += 1;
      return new Response(JSON.stringify({ csrf: "csrf-token-123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (pathName === "/login") {
      obs.loginHits += 1;
      const bodyText = init?.body ? String(init.body) : "";
      const params = new URLSearchParams(bodyText);
      obs.loginCsrf = params.get("csrf");
      obs.loginUsername = params.get("username");
      obs.loginPassword = params.get("password");
      tokenCounter += 1;
      return new Response(JSON.stringify({ session_token: `sess-${tokenCounter}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (pathName === "/data") {
      obs.dataHits += 1;
      const headers = new Headers(init?.headers);
      const auth = headers.get("Authorization");
      obs.dataAuthHeaders.push(auth ?? "");
      if (pending401) {
        pending401 = false;
        return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
      }
      return new Response(JSON.stringify({ data: "secret-payload", seenAuth: auth }), {
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
      // Merge an init from a Request object so header/body observations work
      // whether the listener passes (Request) or (url, init).
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
    arm401Once() {
      pending401 = true;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

// ─────────────────────────────────────────────
// Test
// ─────────────────────────────────────────────

describe("connect.tool run-start — real spawned python MCP server (P1–P3 e2e)", () => {
  runE2e(
    "mints the session at boot, hides login, injects Bearer on fetch_data, and re-logins on 401",
    async () => {
      const upstream = installUpstream();
      const platformFetch = makePlatformFetch();

      // Force the in-process runtime adapter: Docker may be reachable on the
      // dev machine, but this e2e spawns the real python server as a host
      // subprocess (no runner image to pull). Matches CLAUDE.md's documented
      // override.
      const prevAdapter = process.env.INTEGRATION_RUNTIME_ADAPTER;
      process.env.INTEGRATION_RUNTIME_ADAPTER = "process";

      let boot: Awaited<ReturnType<typeof bootIntegrations>> | null = null;
      try {
        boot = await bootIntegrations([spec()], {
          platformApiUrl: "http://platform.local",
          runToken: "run-tok-e2e",
          fetchFn: platformFetch,
        });

        // ── Assertion 0: the integration booted (no failure). ──
        expect(boot.failed).toEqual([]);
        expect(boot.spawned.length).toBe(1);
        expect(boot.spawned[0]!.integrationId).toBe(INTEG_ID);

        // ── Assertion 1: login ran at boot and minted the session. ──
        // The login tool issued GET /csrf then POST /login through the MITM.
        expect(upstream.obs.csrfHits).toBe(1);
        expect(upstream.obs.loginHits).toBe(1);
        expect(upstream.obs.loginCsrf).toBe("csrf-token-123");

        // ── Assertion 2a: substitution worked end-to-end — the upstream
        // /login saw the REAL credentials even though the tool was invoked
        // with empty args (the MITM substituted {{email}}/{{password}}). ──
        expect(upstream.obs.loginUsername).toBe(REAL_EMAIL);
        expect(upstream.obs.loginPassword).toBe(REAL_PASSWORD);

        // ── Assertion 3: the login tool is NOT exposed to the agent. ──
        const agentToolNames = boot.tools.map((t) => t.descriptor.name);
        expect(agentToolNames.some((n) => n.endsWith("__login"))).toBe(false);
        expect(agentToolNames.some((n) => n.endsWith("__fetch_data"))).toBe(true);

        const fetchDataTool = boot.tools.find((t) => t.descriptor.name.endsWith("__fetch_data"));
        expect(fetchDataTool).toBeDefined();

        // ── Assertion 2b: calling fetch_data injects the captured session. ──
        const callFetchData = async () => {
          const res = await fetchDataTool!.handler({}, {} as never);
          const text = (res.content?.[0] as { text?: string } | undefined)?.text ?? "";
          return JSON.parse(text) as { status: number; body: string };
        };

        const r1 = await callFetchData();
        expect(r1.status).toBe(200);
        const body1 = JSON.parse(r1.body) as { data: string; seenAuth: string };
        expect(body1.data).toBe("secret-payload");
        // The injected session (sess-1) reached upstream as a Bearer header.
        expect(body1.seenAuth).toBe("Bearer sess-1");
        expect(upstream.obs.dataAuthHeaders.at(-1)).toBe("Bearer sess-1");

        // ── Assertion 4: P3 reauth — a 401 re-runs the real login tool and
        // the retried /data succeeds with a fresh session. ──
        upstream.arm401Once();
        const r2 = await callFetchData();
        expect(r2.status).toBe(200);
        const body2 = JSON.parse(r2.body) as { data: string; seenAuth: string };
        expect(body2.data).toBe("secret-payload");
        // login re-ran → fresh token sess-2 minted and injected on the retry.
        expect(upstream.obs.loginHits).toBe(2);
        expect(body2.seenAuth).toBe("Bearer sess-2");
      } finally {
        if (boot) await boot.shutdown();
        upstream.restore();
        if (prevAdapter === undefined) delete process.env.INTEGRATION_RUNTIME_ADAPTER;
        else process.env.INTEGRATION_RUNTIME_ADAPTER = prevAdapter;
      }
    },
    30_000,
  );
});

// ─────────────────────────────────────────────
// Fixture manifest contract (no spawn — always runs)
// ─────────────────────────────────────────────

describe("connect-tool-test fixture manifest", () => {
  it("validates and declares the connect.tool run-start contract", () => {
    const raw = readFileSync(path.join(FIXTURE_DIR, "manifest.json"), "utf-8");
    const result = validateManifest(JSON.parse(raw));
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error(result.errors.join(", "));

    const manifest = result.manifest as unknown as {
      type: string;
      name: string;
      server: { type: string; entryPoint: string };
      auths: Record<
        string,
        {
          type: string;
          authorizedUris: string[];
          credentials: { schema: { required?: string[] } };
          connect: { tool: string; runAt: string; produces: string[]; reauthOn: number[] };
          delivery: { http: { headerName: string; headerPrefix?: string; valueFrom: string } };
        }
      >;
      tools: Record<string, unknown>;
    };

    expect(manifest.type).toBe("integration");
    expect(manifest.name).toBe(INTEG_ID);
    expect(manifest.server).toEqual({ type: "python", entryPoint: "./server.py" });

    const session = manifest.auths.session!;
    expect(session.type).toBe("custom");
    expect(session.authorizedUris).toEqual(AUTHORIZED_URIS);
    expect(session.credentials.schema.required).toEqual(["email", "password"]);
    expect(session.connect).toMatchObject({
      tool: "login",
      runAt: "run-start",
      produces: ["session_token"],
      reauthOn: [401],
    });
    expect(session.delivery.http).toMatchObject({
      headerName: "Authorization",
      headerPrefix: "Bearer ",
      valueFrom: "session_token",
    });

    // Both tools declared; `fetch_data` is the agent-facing one.
    expect(Object.keys(manifest.tools).sort()).toEqual(["fetch_data", "login"]);
  });
});
