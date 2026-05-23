// SPDX-License-Identifier: Apache-2.0

/**
 * Kijiji connect.tool (run-start) substrate — REAL spawned node MCP server e2e.
 *
 * Mirrors `integrations-boot-connect-tool-e2e.test.ts` but for the migrated
 * `@default/kijiji` integration: a kijiji-shaped node MCP fixture (the same
 * CAS + OAuth login logic as /implantation's `providers/kijiji/server.js`)
 * spawned through the process runtime adapter, with a per-run CA + per-SNI
 * MITM listener, against a mocked Kijiji upstream (www / id / capi).
 *
 * The session model is multi-cookie: `login` captures kj-st / kj-at / kj-ct
 * and the manifest's `delivery.http` renders them into a single `Cookie`
 * header the MITM injects on `whoami` / `get_conversations`.
 *
 * What is REAL: the node `server.js` subprocess driven over MCP stdio; the
 * 4-step HTTPS dance through HTTPS_PROXY, TLS-intercepted by the MITM with a
 * minted leaf cert the process trusts; the `{{email}}`/`{{password}}`
 * substitution + the `Cookie` injection in the listener; the reauthOn:[401]
 * re-login path on a real upstream 401.
 *
 * What is mocked: the platform `/internal/integration-*` endpoints (injected
 * fetchFn) and the Kijiji upstream hosts (globalThis.fetch routing).
 *
 * Skipped when openssl or node are missing (process-mode requires both).
 */

import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import { readFileSync, existsSync } from "node:fs";
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
const HAS_NODE = await toolAvailable(["node", "--version"]);
const RUNNABLE = HAS_OPENSSL && HAS_NODE;
if (!RUNNABLE) {
  console.warn(`[kijiji-e2e] skipped — openssl=${HAS_OPENSSL} node=${HAS_NODE} (both required)`);
}
const runE2e: typeof it = RUNNABLE ? it : (it.skip as unknown as typeof it);

// ─────────────────────────────────────────────
// Fixture bundle (the kijiji-shaped node fixture, zipped on the fly)
// ─────────────────────────────────────────────

// Prefer the REAL migrated connector at /implantation/providers/kijiji so this
// e2e exercises the actual `server.js` shipped there, not just a mirror. Falls
// back to the in-repo mirror fixture when /implantation is absent (e.g. CI),
// keeping the test self-contained. The two server.js implement the same CAS
// dance; testing the real one locally removes the drift gap.
const REAL_CONNECTOR_DIR = "/Users/pierrecabriere/Dev/implantation/providers/kijiji";
const MIRROR_DIR = path.join(import.meta.dir, "fixtures/kijiji");
const FIXTURE_DIR = existsSync(path.join(REAL_CONNECTOR_DIR, "server.js"))
  ? REAL_CONNECTOR_DIR
  : MIRROR_DIR;
const INTEG_ID = "@default/kijiji";
const NAMESPACE = "kijiji";

const WWW = "www.kijiji.ca";
const ID = "id.kijiji.ca";
const CAPI = "capi.kijiji.ca";
const AUTHORIZED_URIS = [`https://${WWW}/**`, `https://${ID}/**`, `https://${CAPI}/**`];

const REAL_EMAIL = "seller@orga.example";
const REAL_PASSWORD = "kj-sup3r-s3cret-pw";

// The Cookie template from the manifest's delivery.http.
const COOKIE_TEMPLATE = "kj-st={{kj_st}}; kj-at={{kj_at}}; kj-ct={{kj_ct}}";

function fixtureBundleBytes(): Uint8Array {
  const server = readFileSync(path.join(FIXTURE_DIR, "server.js"));
  // Build a minimal integration manifest for the bundle. (The test's spawn
  // spec carries the runtime contract; this manifest only needs to satisfy
  // the bundle reader's server.type → entryPoint mapping.)
  const manifest = {
    $schema: "https://afps.appstrate.dev/packages/schema/v1/integration.schema.json",
    manifestVersion: "1.1",
    type: "integration",
    name: INTEG_ID,
    version: "1.1.0",
    displayName: "Kijiji",
    server: { type: "node", entryPoint: "./server.js" },
    transport: { type: "stdio" },
    auths: {
      session: {
        type: "custom",
        required: true,
        authorizedUris: AUTHORIZED_URIS,
        credentials: {
          schema: {
            type: "object",
            required: ["email", "password"],
            properties: { email: { type: "string" }, password: { type: "string" } },
          },
        },
        connect: {
          tool: "login",
          runAt: "run-start",
          persistLoginSecret: true,
          produces: ["kj_st", "kj_at", "kj_ct", "sub"],
          reauthOn: [401],
        },
        delivery: { http: { headerName: "Cookie", valueFrom: { template: COOKIE_TEMPLATE } } },
      },
    },
    tools: {
      login: { requiredAuthKey: "session" },
      whoami: { requiredAuthKey: "session" },
      get_conversations: { requiredAuthKey: "session" },
    },
  };
  return zipArtifact({
    "manifest.json": new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    "server.js": new Uint8Array(server),
  });
}

function placeholderWire(): IntegrationCredentialsWire {
  return {
    auths: [
      { authKey: "session", authType: "custom", fields: {}, authorizedUris: AUTHORIZED_URIS },
    ],
    deliveryPlans: {
      session: { headerName: "Cookie", value: "", allowServerOverride: false },
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
      version: "1.1.0",
      server: { type: "node", entryPoint: "./server.js" },
    },
    spawnEnv: {},
    // The spawn resolver strips `login` from the allowlist — the agent only
    // ever selects the data tools.
    toolAllowlist: ["whoami", "get_conversations"],
    httpDeliveryAuths: {
      session: {
        authType: "custom",
        headerName: "Cookie",
        value: "",
        allowServerOverride: false,
        authorizedUris: AUTHORIZED_URIS,
      },
    },
    connectLogin: {
      toolName: "login",
      produces: ["kj_st", "kj_at", "kj_ct", "sub"],
      authKey: "session",
      authType: "custom",
      authorizedUris: AUTHORIZED_URIS,
      deliveryHttp: { headerName: "Cookie", valueFrom: { template: COOKIE_TEMPLATE } },
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

// ─────────────────────────────────────────────
// Kijiji upstream mock (www / id / capi) — a fake CAS host.
// Installed by routing globalThis.fetch for the three kijiji hosts to a local
// handler. The MITM listener forwards via globalThis.fetch.
// ─────────────────────────────────────────────

interface UpstreamObservations {
  loginUsername: string | null;
  loginPassword: string | null;
  loginExecution: string | null;
  csrfHits: number;
  signinHits: number;
  casLoginHits: number;
  sessionCookieHeaders: string[]; // Cookie header seen on /api/auth/session
  conversationsCookieHeaders: string[];
}

interface UpstreamHandle {
  obs: UpstreamObservations;
  /** Make the NEXT /api/auth/session call return 401 once (drives reauth). */
  armSession401Once(): void;
  restore(): void;
}

const KIJIJI_HOSTS = new Set([WWW, ID, CAPI]);

function installUpstream(): UpstreamHandle {
  const obs: UpstreamObservations = {
    loginUsername: null,
    loginPassword: null,
    loginExecution: null,
    csrfHits: 0,
    signinHits: 0,
    casLoginHits: 0,
    sessionCookieHeaders: [],
    conversationsCookieHeaders: [],
  };
  let pendingSession401 = false;
  let cookieCounter = 0;
  // Cookies minted by the most recent successful CAS login.
  let current: { st: string; at: string; ct: string } | null = null;
  // Set by a successful CAS /login, consumed by the immediately-following
  // /api/auth/session login-validation hop. During that hop the freshly-minted
  // session header is not yet installed (login is *capturing* it) and on a
  // re-login the STALE session header is still installed — so the validation
  // hop must surface the new session regardless of the injected cookie.
  let justLoggedIn = false;

  const originalFetch = globalThis.fetch;

  const hasSessionCookies = (cookie: string | null): boolean => {
    if (!cookie || !current) return false;
    return (
      cookie.includes(`kj-st=${current.st}`) &&
      cookie.includes(`kj-at=${current.at}`) &&
      cookie.includes(`kj-ct=${current.ct}`)
    );
  };

  const handle = async (host: string, url: URL, init?: RequestInit): Promise<Response> => {
    const p = url.pathname;
    const headers = new Headers(init?.headers);

    // ── www.kijiji.ca/api/auth/csrf ──
    if (host === WWW && p === "/api/auth/csrf") {
      obs.csrfHits += 1;
      return new Response(JSON.stringify({ csrfToken: "csrf-tok-abc" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── www.kijiji.ca/api/auth/signin/cis → CAS form HTML ──
    if (host === WWW && p === "/api/auth/signin/cis") {
      obs.signinHits += 1;
      const html =
        '<html><body><form id="login" method="post">' +
        '<input type="hidden" name="execution" value="e1s1-exec-token" />' +
        '<input type="hidden" name="tmSessionId" value="tm-session-xyz" />' +
        '<input type="hidden" name="service" value="https://www.kijiji.ca/api/auth/callback/cis" />' +
        '<input name="username" /><input name="password" />' +
        "</form></body></html>";
      return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
    }

    // ── id.kijiji.ca/login → mint cookies on the right creds ──
    if (host === ID && p === "/login") {
      obs.casLoginHits += 1;
      const bodyText = init?.body ? String(init.body) : "";
      const params = new URLSearchParams(bodyText);
      obs.loginUsername = params.get("username");
      obs.loginPassword = params.get("password");
      obs.loginExecution = params.get("execution");
      if (params.get("username") === REAL_EMAIL && params.get("password") === REAL_PASSWORD) {
        cookieCounter += 1;
        current = {
          st: `st-${cookieCounter}`,
          at: `at-${cookieCounter}`,
          ct: `ct-${cookieCounter}`,
        };
        justLoggedIn = true;
        return new Response("", {
          status: 302,
          headers: {
            Location: "https://www.kijiji.ca/",
            // Real Kijiji sets these across the redirect chain; the fixture
            // also exposes them on /api/auth/session for capture.
            "Set-Cookie": `kj-st=${current.st}; kj-at=${current.at}; kj-ct=${current.ct}`,
          },
        });
      }
      return new Response("bad credentials", { status: 401 });
    }

    // ── www.kijiji.ca/api/auth/session → whoami / login validation ──
    if (host === WWW && p === "/api/auth/session") {
      const cookie = headers.get("Cookie");
      obs.sessionCookieHeaders.push(cookie ?? "");

      // login-validation hop — the /session call the login tool makes right
      // after a successful CAS login. The fresh session header isn't installed
      // yet (and on re-login the stale one still is), so accept it regardless
      // of the injected cookie and surface the fresh session for capture.
      if (justLoggedIn && current) {
        justLoggedIn = false;
        return new Response(
          JSON.stringify({
            user: { sub: "kj-user-42", type: "FSBO" },
            cookies: { "kj-st": current.st, "kj-at": current.at, "kj-ct": current.ct },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (pendingSession401) {
        pendingSession401 = false;
        return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
      }
      if (!current || !hasSessionCookies(cookie)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
      // Authenticated whoami via injected cookies.
      return new Response(
        JSON.stringify({
          user: { sub: "kj-user-42", type: "FSBO" },
          cookies: { "kj-st": current.st, "kj-at": current.at, "kj-ct": current.ct },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── capi.kijiji.ca/web/v8/conversations ──
    if (host === CAPI && p === "/web/v8/conversations") {
      const cookie = headers.get("Cookie");
      obs.conversationsCookieHeaders.push(cookie ?? "");
      if (!hasSessionCookies(cookie)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
      return new Response(JSON.stringify({ conversations: [{ id: "conv-1", peer: "buyer-1" }] }), {
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
    if (parsed && KIJIJI_HOSTS.has(parsed.hostname)) {
      if (input instanceof Request && !init) {
        const body =
          input.method === "GET" || input.method === "HEAD" ? undefined : await input.text();
        return handle(parsed.hostname, parsed, {
          method: input.method,
          headers: input.headers,
          body,
        });
      }
      return handle(parsed.hostname, parsed, init);
    }
    return originalFetch(input as never, init);
  }) as unknown as typeof fetch;

  return {
    obs,
    armSession401Once() {
      pendingSession401 = true;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

// ─────────────────────────────────────────────
// Test
// ─────────────────────────────────────────────

describe("kijiji connect.tool run-start — real spawned node MCP server (e2e)", () => {
  runE2e(
    "mints the cookie session at boot, hides login, injects Cookie on data tools, re-logins on 401",
    async () => {
      const upstream = installUpstream();
      const platformFetch = makePlatformFetch();

      const prevAdapter = process.env.INTEGRATION_RUNTIME_ADAPTER;
      process.env.INTEGRATION_RUNTIME_ADAPTER = "process";

      let boot: Awaited<ReturnType<typeof bootIntegrations>> | null = null;
      try {
        boot = await bootIntegrations([spec()], {
          platformApiUrl: "http://platform.local",
          runToken: "run-tok-kijiji",
          fetchFn: platformFetch,
        });

        // ── Assertion 0: the integration booted. ──
        expect(boot.failed).toEqual([]);
        expect(boot.spawned.length).toBe(1);
        expect(boot.spawned[0]!.integrationId).toBe(INTEG_ID);

        // ── Assertion 1: login ran at boot — the full CAS dance executed. ──
        expect(upstream.obs.csrfHits).toBe(1);
        expect(upstream.obs.signinHits).toBe(1);
        expect(upstream.obs.casLoginHits).toBe(1);
        // The hidden CAS token parsed from the form HTML reached the CAS POST.
        expect(upstream.obs.loginExecution).toBe("e1s1-exec-token");

        // ── Assertion 1b: substitution worked — the upstream CAS /login saw
        // the REAL credentials even though the tool was invoked with empty
        // args (the MITM substituted {{email}}/{{password}} proxy-side). ──
        expect(upstream.obs.loginUsername).toBe(REAL_EMAIL);
        expect(upstream.obs.loginPassword).toBe(REAL_PASSWORD);

        // ── Assertion 3: the login tool is NOT exposed to the agent. ──
        const agentToolNames = boot.tools.map((t) => t.descriptor.name);
        expect(agentToolNames.some((n) => n.endsWith("__login"))).toBe(false);
        expect(agentToolNames.some((n) => n.endsWith("__whoami"))).toBe(true);
        expect(agentToolNames.some((n) => n.endsWith("__get_conversations"))).toBe(true);

        const whoamiTool = boot.tools.find((t) => t.descriptor.name.endsWith("__whoami"));
        expect(whoamiTool).toBeDefined();

        // ── Assertion 2: whoami injects the captured cookie session. ──
        const callTool = async (
          tool: NonNullable<typeof whoamiTool>,
        ): Promise<{ status: number; body: string }> => {
          const res = await tool.handler({}, {} as never);
          const text = (res.content?.[0] as { text?: string } | undefined)?.text ?? "";
          return JSON.parse(text) as { status: number; body: string };
        };

        const r1 = await callTool(whoamiTool!);
        expect(r1.status).toBe(200);
        const user1 = JSON.parse(r1.body) as { user: { sub: string } };
        expect(user1.user.sub).toBe("kj-user-42");
        // The injected Cookie header carried all three kj-* cookies (snapshot 1).
        const lastSessionCookie = upstream.obs.sessionCookieHeaders.at(-1) ?? "";
        expect(lastSessionCookie).toContain("kj-st=st-1");
        expect(lastSessionCookie).toContain("kj-at=at-1");
        expect(lastSessionCookie).toContain("kj-ct=ct-1");

        // get_conversations rides the same injected session.
        const convTool = boot.tools.find((t) => t.descriptor.name.endsWith("__get_conversations"));
        const rc = await callTool(convTool!);
        expect(rc.status).toBe(200);
        const convCookie = upstream.obs.conversationsCookieHeaders.at(-1) ?? "";
        expect(convCookie).toContain("kj-st=st-1");

        // ── Assertion 4: reauthOn:[401] — a 401 on /api/auth/session re-runs
        // the real login tool (fresh cookie snapshot) and the retry succeeds. ──
        upstream.armSession401Once();
        const r2 = await callTool(whoamiTool!);
        expect(r2.status).toBe(200);
        const user2 = JSON.parse(r2.body) as { user: { sub: string } };
        expect(user2.user.sub).toBe("kj-user-42");
        // login re-ran → a fresh cookie snapshot (counter 2) minted + injected.
        expect(upstream.obs.casLoginHits).toBe(2);
        const retryCookie = upstream.obs.sessionCookieHeaders.at(-1) ?? "";
        expect(retryCookie).toContain("kj-st=st-2");
        expect(retryCookie).toContain("kj-at=at-2");
        expect(retryCookie).toContain("kj-ct=ct-2");
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
// Migrated manifest contract (no spawn — always runs)
// ─────────────────────────────────────────────

describe("@default/kijiji integration manifest", () => {
  it("validates and declares the connect.tool run-start cookie contract", () => {
    // Validate the migrated /implantation manifest in-place.
    const manifestPath = path.join(
      import.meta.dir,
      "../../../../implantation/providers/kijiji/manifest.json",
    );
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch {
      // /implantation is a sibling repo and may be absent in CI — fall back to
      // the bundled fixture manifest so the contract assertion still runs.
      const fallback = JSON.parse(
        new TextDecoder().decode(
          (function () {
            // reuse fixtureBundleBytes' manifest by reconstructing it inline
            return new TextEncoder().encode(
              JSON.stringify({
                $schema: "https://afps.appstrate.dev/packages/schema/v1/integration.schema.json",
                manifestVersion: "1.1",
                type: "integration",
                name: INTEG_ID,
                version: "1.1.0",
                displayName: "Kijiji",
                server: { type: "node", entryPoint: "./server.js" },
                auths: {
                  session: {
                    type: "custom",
                    required: true,
                    authorizedUris: AUTHORIZED_URIS,
                    credentials: {
                      schema: {
                        type: "object",
                        required: ["email", "password"],
                        properties: {
                          email: { type: "string" },
                          password: { type: "string" },
                        },
                      },
                    },
                    connect: {
                      tool: "login",
                      runAt: "run-start",
                      persistLoginSecret: true,
                      produces: ["kj_st", "kj_at", "kj_ct", "sub"],
                      reauthOn: [401],
                    },
                    delivery: {
                      http: { headerName: "Cookie", valueFrom: { template: COOKIE_TEMPLATE } },
                    },
                  },
                },
                tools: {
                  login: { requiredAuthKey: "session" },
                  whoami: { requiredAuthKey: "session" },
                  get_conversations: { requiredAuthKey: "session" },
                },
              }),
            );
          })(),
        ),
      );
      raw = fallback;
    }

    const result = validateManifest(raw);
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error(result.errors.join(", "));

    const manifest = raw as {
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
          delivery: { http: { headerName: string; valueFrom: { template: string } } };
        }
      >;
      tools: Record<string, unknown>;
    };

    expect(manifest.type).toBe("integration");
    expect(manifest.name).toBe(INTEG_ID);
    expect(manifest.server.type).toBe("node");

    const session = manifest.auths.session!;
    expect(session.type).toBe("custom");
    expect(session.authorizedUris).toEqual(AUTHORIZED_URIS);
    expect(session.credentials.schema.required).toEqual(["email", "password"]);
    expect(session.connect).toMatchObject({
      tool: "login",
      runAt: "run-start",
      produces: ["kj_st", "kj_at", "kj_ct", "sub"],
      reauthOn: [401],
    });
    expect(session.delivery.http.headerName).toBe("Cookie");
    expect(session.delivery.http.valueFrom.template).toBe(COOKIE_TEMPLATE);

    // login is the connect tool; whoami + get_conversations are agent-facing.
    expect(Object.keys(manifest.tools).sort()).toEqual(["get_conversations", "login", "whoami"]);
  });
});
