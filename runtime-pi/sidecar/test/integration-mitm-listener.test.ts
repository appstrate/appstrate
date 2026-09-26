// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the per-integration HTTPS MITM listener.
 *
 * Two layers of coverage:
 *   1. Pure unit tests for behaviour that doesn't need a TCP socket:
 *      preamble parsing, header forwarding contracts, refusal paths.
 *   2. Real-network end-to-end tests using `node:https` upstream servers
 *      bound to ephemeral ports, the real cert minter, the real CA
 *      generator, and an actual HTTPS_PROXY-aware fetch (Node's
 *      `https.request` doesn't honour HTTPS_PROXY by itself, so we drive
 *      the CONNECT+TLS dance manually via `http.request` + `tls.connect`
 *      against the listener — mirroring exactly what `Bun.fetch` would
 *      do under the integration's HTTPS_PROXY env).
 *
 * The end-to-end tests are skipped when openssl is unavailable.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { connect as tlsConnect } from "node:tls";
import { connect as netConnect } from "node:net";
import {
  planCaBundle,
  type IntegrationCredentialsPayload,
  type HttpDeliveryPlan,
} from "@appstrate/connect";
import { createOpensslCertGenerator } from "../ca-cert-openssl.ts";
import { createCertMinter } from "../integration-cert-minter.ts";
import { compileEgressPolicy } from "@appstrate/afps-runtime/resolvers";
import {
  createIntegrationMitmListener,
  type MitmCredentialSource,
  type MitmListenerEvent,
} from "../integration-mitm-listener.ts";

async function opensslAvailable(): Promise<boolean> {
  try {
    const proc = (
      globalThis as unknown as {
        Bun?: { spawn: (args: string[], opts: object) => { exited: Promise<number> } };
      }
    ).Bun?.spawn(["openssl", "version"], { stdout: "pipe", stderr: "pipe" });
    if (!proc) return false;
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

const HAS_OPENSSL = await opensslAvailable();
if (!HAS_OPENSSL) {
  console.warn("[integration-mitm-listener] openssl missing — TLS tests skipped");
}
const runIfOpenssl: typeof it = HAS_OPENSSL ? it : (it.skip as unknown as typeof it);

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * The SNI hosts in this suite (`api.test.local`, …) don't resolve in real
 * DNS, and the listener's SSRF floor fails closed on resolution failure —
 * stub the rebind-guard resolver to a public TEST-NET-3 address so the
 * tunnels under test open. Rebind refusal is covered explicitly in the
 * "SSRF floor" describe below.
 */
const stubResolveHost = async () => ["203.0.113.10"];

/** Allow-all egress gates for tests about something else; the #1458 describe overrides them. */
const permissiveEgress = {
  egressPolicy: { allowsAuthority: () => true, allowsUrl: () => true },
  isPeerAllowed: async () => true,
};

async function makeCaBundle() {
  const workDir = path.join(tmpdir(), `afps-mitm-ca-${randomUUID()}`);
  await fs.mkdir(workDir, { recursive: true });
  const gen = createOpensslCertGenerator({ workDir });
  return planCaBundle({
    runId: "mitm-test",
    tmpfsRoot: workDir,
    generator: gen,
    serverCommonName: "localhost",
    notAfterSeconds: 3600,
  });
}

function payload(
  authKey: string,
  authType: string,
  fields: Record<string, string>,
  authorizedUris: string[],
): IntegrationCredentialsPayload {
  return {
    auths: [
      {
        authKey,
        authType,
        fields: Object.freeze({ ...fields }),
        authorizedUris: Object.freeze([...authorizedUris]),
      },
    ],
  };
}

function plan(headerName: string, value: string, prefix = "Bearer "): HttpDeliveryPlan {
  return { headerName, headerPrefix: prefix, value, allowServerOverride: false };
}

/**
 * Drive an HTTPS request through the MITM listener using only
 * Node primitives — `http.request` CONNECT, then `tls.connect` over the
 * tunnel, then write the inner HTTP/1.1 request manually. Mirrors what
 * Bun.fetch does under HTTPS_PROXY.
 *
 * Because the upstream uses a self-signed cert that's NOT the run CA
 * (the upstream is "the real internet" from the listener's perspective,
 * not part of our CA chain), we tell tls.connect to skip cert validation
 * on the INNER socket by passing `rejectUnauthorized: false`. The
 * listener's job is to terminate TLS using the CA chain — that side is
 * verified by passing the CA root to `rejectUnauthorized`.
 */
async function drivenFetch(opts: {
  listenerPort: number;
  /** SNI host the listener should mint a cert for. */
  sni: string;
  /** Port named in the CONNECT (defaults to 443). */
  port?: number;
  /** CA PEM to trust for the inner TLS chain. */
  caCertPem: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    // 1) Raw TCP to the listener.
    const raw = netConnect(opts.listenerPort, "127.0.0.1", () => {
      // 2) Send CONNECT preamble.
      const target = `${opts.sni}:${opts.port ?? 443}`;
      raw.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    raw.on("error", reject);

    // 3) Wait for the "200 Connection Established" reply, then unshift the rest.
    let preamble = Buffer.alloc(0);
    const onPreamble = (chunk: Buffer) => {
      preamble = Buffer.concat([preamble, chunk]);
      const end = preamble.indexOf("\r\n\r\n");
      if (end === -1) return;
      raw.off("data", onPreamble);
      const status = preamble.slice(0, preamble.indexOf("\r\n")).toString();
      if (!status.match(/HTTP\/1\.\d 200/)) {
        reject(new Error(`CONNECT replied: ${status}`));
        return;
      }
      const remainder = preamble.slice(end + 4);
      if (remainder.length > 0) raw.unshift(remainder);

      // 4) Wrap the TCP socket in TLS targeted at the SNI host.
      const tlsSocket = tlsConnect({
        socket: raw,
        servername: opts.sni,
        ca: opts.caCertPem,
      });
      tlsSocket.on("error", reject);
      tlsSocket.on("secureConnect", () => {
        // 5) Send the inner HTTP/1.1 request.
        const headerLines = [`${opts.method} ${opts.path} HTTP/1.1`, `Host: ${opts.sni}`];
        for (const [k, v] of Object.entries(opts.headers)) headerLines.push(`${k}: ${v}`);
        const body = opts.body ?? "";
        if (body.length > 0) headerLines.push(`Content-Length: ${Buffer.byteLength(body)}`);
        headerLines.push("Connection: close");
        tlsSocket.write(headerLines.join("\r\n") + "\r\n\r\n" + body);

        // 6) Collect the response until socket close.
        const chunks: Buffer[] = [];
        tlsSocket.on("data", (c: Buffer) => chunks.push(c));
        tlsSocket.on("end", () => {
          const full = Buffer.concat(chunks).toString("utf-8");
          const split = full.indexOf("\r\n\r\n");
          const head = split >= 0 ? full.slice(0, split) : full;
          const respBody = split >= 0 ? full.slice(split + 4) : "";
          const lines = head.split("\r\n");
          const statusLine = lines[0] ?? "";
          const m = statusLine.match(/HTTP\/1\.\d (\d+)/);
          const status = m ? Number.parseInt(m[1]!, 10) : 0;
          const headers: Record<string, string> = {};
          for (const line of lines.slice(1)) {
            const idx = line.indexOf(":");
            if (idx > 0)
              headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
          }
          resolve({ status, headers, body: respBody });
        });
      });
    };
    raw.on("data", onPreamble);
  });
}

/**
 * Make Bun.fetch route to a fake upstream by intercepting the URL. We
 * use this when the test wants to focus on the listener's strip/inject
 * behaviour without binding a real upstream HTTPS server.
 */
function makeRecordingFetch(respond: (url: string, init: RequestInit) => Promise<Response>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const i = init ?? {};
    calls.push({ url, init: i });
    return respond(url, i);
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe("MITM listener — CONNECT preamble", () => {
  runIfOpenssl("rejects non-CONNECT methods with 405", async () => {
    const bundle = await makeCaBundle();
    const minter = createCertMinter({
      caCertPem: bundle.pems.caCertPem,
      caKeyPem: bundle.pems.caKeyPem,
    });
    const creds: MitmCredentialSource = {
      current: () => ({ auths: [] }),
      deliveryPlans: () => ({}),
    };
    const listener = createIntegrationMitmListener({
      caBundle: bundle,
      minter,
      credentials: creds,
      ...permissiveEgress,
      resolveHostFn: stubResolveHost,
    });
    await listener.ready;
    try {
      const addr = listener.address();
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const sock = netConnect(addr.port, addr.host, () => {
          sock.write("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n");
        });
        sock.on("error", reject);
        const buf: Buffer[] = [];
        sock.on("data", (c: Buffer) => buf.push(c));
        sock.on("end", () => {
          const txt = Buffer.concat(buf).toString();
          const m = txt.match(/HTTP\/1\.\d (\d+)/);
          resolve({ status: m ? Number.parseInt(m[1]!, 10) : 0, body: txt });
        });
        sock.on("close", () => {
          if (buf.length === 0) resolve({ status: 0, body: "" });
        });
      });
      expect(res.status).toBe(405);
    } finally {
      await listener.close();
    }
  });
});

describe("MITM listener — strip + inject end-to-end", () => {
  runIfOpenssl("strips caller Authorization and injects the rendered Bearer", async () => {
    const bundle = await makeCaBundle();
    const minter = createCertMinter({
      caCertPem: bundle.pems.caCertPem,
      caKeyPem: bundle.pems.caKeyPem,
    });

    const pl = payload("vendor", "oauth2", { access_token: "fresh-token" }, [
      `https://api.test.local/**`,
    ]);
    const dp: Record<string, HttpDeliveryPlan> = {
      vendor: plan("Authorization", "fresh-token"),
    };
    const creds: MitmCredentialSource = {
      current: () => pl,
      deliveryPlans: () => dp,
    };

    // Capture the upstream fetch arguments verbatim — no real HTTPS
    // server needed. The listener's strip/inject decisions are fully
    // observable from `init.headers` and `init.body`.
    const captured: { url: string; init: RequestInit }[] = [];
    const recordedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const reqInit = init ?? {};
      // Pre-read the body so the listener's downstream `await response.body`
      // doesn't race against the test assertion.
      const bodyBytes = reqInit.body
        ? typeof reqInit.body === "string"
          ? new TextEncoder().encode(reqInit.body)
          : new Uint8Array(reqInit.body as ArrayBuffer)
        : new Uint8Array(0);
      captured.push({
        url,
        init: {
          ...reqInit,
          headers: reqInit.headers as Headers,
          body: bodyBytes.byteLength > 0 ? Buffer.from(bodyBytes).toString("utf-8") : undefined,
        },
      });
      return new Response(`{"echoed":true}`, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const listener = createIntegrationMitmListener({
      caBundle: bundle,
      minter,
      credentials: creds,
      ...permissiveEgress,
      resolveHostFn: stubResolveHost,
      fetch: recordedFetch,
    });
    await listener.ready;

    try {
      const addr = listener.address();
      const out = await drivenFetch({
        listenerPort: addr.port,
        sni: "api.test.local",
        caCertPem: bundle.pems.caCertPem,
        method: "POST",
        path: "/v1/things",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer smuggled-token",
        },
        body: `{"hello":"world"}`,
      });

      expect(out.status).toBe(200);
      expect(out.body).toBe(`{"echoed":true}`);
      expect(captured.length).toBe(1);
      expect(captured[0]!.url).toBe("https://api.test.local/v1/things");
      expect(captured[0]!.init.method).toBe("POST");
      expect(captured[0]!.init.body).toBe(`{"hello":"world"}`);
      const sentHeaders = captured[0]!.init.headers as Headers;
      expect(sentHeaders.get("Authorization")).toBe("Bearer fresh-token");
      expect(sentHeaders.get("Host")).toBe("api.test.local");
    } finally {
      await listener.close();
    }
  });

  runIfOpenssl("forwards without injection when no auth matches", async () => {
    const bundle = await makeCaBundle();
    const minter = createCertMinter({
      caCertPem: bundle.pems.caCertPem,
      caKeyPem: bundle.pems.caKeyPem,
    });

    const pl = payload("vendor", "oauth2", { access_token: "fresh" }, [
      "https://api.other.local/**", // does NOT match
    ]);
    const dp: Record<string, HttpDeliveryPlan> = { vendor: plan("Authorization", "fresh") };
    const creds: MitmCredentialSource = {
      current: () => pl,
      deliveryPlans: () => dp,
    };

    const captured: { headers: Headers }[] = [];
    const recordedFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Headers;
      captured.push({ headers });
      return new Response(`{"ok":true}`, { status: 200 });
    }) as unknown as typeof fetch;

    const listener = createIntegrationMitmListener({
      caBundle: bundle,
      minter,
      credentials: creds,
      ...permissiveEgress,
      resolveHostFn: stubResolveHost,
      fetch: recordedFetch,
    });
    await listener.ready;

    try {
      const addr = listener.address();
      const out = await drivenFetch({
        listenerPort: addr.port,
        sni: "api.unmatched.local",
        caCertPem: bundle.pems.caCertPem,
        method: "GET",
        path: "/",
        headers: { Authorization: "Bearer caller-token" },
      });
      expect(out.status).toBe(200);
      expect(captured.length).toBe(1);
      // No matched auth → Authorization stripped, none injected.
      expect(captured[0]!.headers.get("Authorization")).toBeNull();
    } finally {
      await listener.close();
    }
  });
});

describe("MITM listener — 401 refresh + retry", () => {
  runIfOpenssl("retries once after refresh on upstream 401", async () => {
    const bundle = await makeCaBundle();
    const minter = createCertMinter({
      caCertPem: bundle.pems.caCertPem,
      caKeyPem: bundle.pems.caKeyPem,
    });

    let upstreamCallNo = 0;
    let refreshCalls = 0;
    let activeToken = "stale";

    const dp: Record<string, HttpDeliveryPlan> = {
      vendor: plan("Authorization", activeToken),
    };
    const pl = payload("vendor", "oauth2", { access_token: activeToken }, [
      "https://api.test.local/**",
    ]);

    const creds: MitmCredentialSource = {
      current: () => pl,
      deliveryPlans: () => dp,
      async refreshOnUnauthorized(authKey) {
        refreshCalls += 1;
        expect(authKey).toBe("vendor");
        activeToken = "fresh";
        dp.vendor = plan("Authorization", activeToken);
        return true;
      },
    };

    const recorded = makeRecordingFetch(async (_url, init) => {
      upstreamCallNo += 1;
      const headers = init.headers as Headers;
      const auth = headers.get("authorization");
      if (auth === "Bearer fresh") {
        return new Response(`{"ok":true}`, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(`{"err":"invalid_token"}`, {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });

    const listener = createIntegrationMitmListener({
      caBundle: bundle,
      minter,
      credentials: creds,
      ...permissiveEgress,
      resolveHostFn: stubResolveHost,
      fetch: recorded.fetch,
    });
    await listener.ready;
    try {
      const addr = listener.address();
      const out = await drivenFetch({
        listenerPort: addr.port,
        sni: "api.test.local",
        caCertPem: bundle.pems.caCertPem,
        method: "GET",
        path: "/v1/items",
        headers: {},
      });
      expect(out.status).toBe(200);
      expect(upstreamCallNo).toBe(2);
      expect(refreshCalls).toBe(1);
    } finally {
      await listener.close();
    }
  });

  runIfOpenssl("api_key 401 routes straight to /refresh (to flag), no rotate-retry", async () => {
    // A 401 on an injected api_key credential has nothing to rotate, so the
    // listener reaches the platform `/refresh` (which flags the connection —
    // modelled by the source returning false). No replay with the same dead
    // credential; the original 401 is surfaced.
    const bundle = await makeCaBundle();
    const minter = createCertMinter({
      caCertPem: bundle.pems.caCertPem,
      caKeyPem: bundle.pems.caKeyPem,
    });

    let upstreamCallNo = 0;
    let refreshCalls = 0;

    const dp: Record<string, HttpDeliveryPlan> = {
      vendor: {
        headerName: "X-Api-Key",
        headerPrefix: "",
        value: "secret",
        allowServerOverride: false,
      },
    };
    const pl = payload("vendor", "api_key", { api_key: "secret" }, ["https://api.test.local/**"]);

    const creds: MitmCredentialSource = {
      current: () => pl,
      deliveryPlans: () => dp,
      async refreshOnUnauthorized() {
        refreshCalls += 1;
        return false; // /refresh flagged the connection; nothing to rotate
      },
    };

    const recorded = makeRecordingFetch(async () => {
      upstreamCallNo += 1;
      return new Response(`{"err":"unauthorized"}`, { status: 401 });
    });

    const listener = createIntegrationMitmListener({
      caBundle: bundle,
      minter,
      credentials: creds,
      ...permissiveEgress,
      resolveHostFn: stubResolveHost,
      fetch: recorded.fetch,
    });
    await listener.ready;
    try {
      const addr = listener.address();
      const out = await drivenFetch({
        listenerPort: addr.port,
        sni: "api.test.local",
        caCertPem: bundle.pems.caCertPem,
        method: "GET",
        path: "/",
        headers: {},
      });
      expect(out.status).toBe(401);
      expect(upstreamCallNo).toBe(1); // no replay with the same dead credential
      expect(refreshCalls).toBe(1); // /refresh reached (to flag)
    } finally {
      await listener.close();
    }
  });

  runIfOpenssl(
    "403 does NOT trigger a refresh (authorization decision, not a dead credential)",
    async () => {
      // A 403 is an authorization decision on a specific resource, not a dead
      // credential — the listener must NOT force a /refresh (which would flag the
      // connection). Only 401 on an injected credential triggers it.
      const bundle = await makeCaBundle();
      const minter = createCertMinter({
        caCertPem: bundle.pems.caCertPem,
        caKeyPem: bundle.pems.caKeyPem,
      });
      let refreshCalls = 0;
      const dp: Record<string, HttpDeliveryPlan> = { vendor: plan("Authorization", "tok") };
      const pl = payload("vendor", "oauth2", { access_token: "tok" }, [
        "https://api.test.local/**",
      ]);
      const creds: MitmCredentialSource = {
        current: () => pl,
        deliveryPlans: () => dp,
        async refreshOnUnauthorized() {
          refreshCalls += 1;
          return false;
        },
      };
      const recorded = makeRecordingFetch(
        async () => new Response(`{"err":"forbidden"}`, { status: 403 }),
      );
      const listener = createIntegrationMitmListener({
        caBundle: bundle,
        minter,
        credentials: creds,
        ...permissiveEgress,
        resolveHostFn: stubResolveHost,
        fetch: recorded.fetch,
      });
      await listener.ready;
      try {
        const out = await drivenFetch({
          listenerPort: listener.address().port,
          sni: "api.test.local",
          caCertPem: bundle.pems.caCertPem,
          method: "GET",
          path: "/v1/items",
          headers: {},
        });
        expect(out.status).toBe(403);
        expect(refreshCalls).toBe(0);
      } finally {
        await listener.close();
      }
    },
  );
});

describe("MITM listener — connect.tool re-login (P3)", () => {
  runIfOpenssl(
    "re-logins + retries once when an upstream status matches reauthOn (custom auth)",
    async () => {
      const bundle = await makeCaBundle();
      const minter = createCertMinter({
        caCertPem: bundle.pems.caCertPem,
        caKeyPem: bundle.pems.caKeyPem,
      });

      let upstreamCallNo = 0;
      let reauthCalls = 0;
      let activeToken = "stale";

      // `custom` auth → the reauth path is driven purely by `shouldReauth`.
      const dp: Record<string, HttpDeliveryPlan> = {
        vendor: plan("X-Session", activeToken, ""),
      };
      const pl = payload("vendor", "custom", { session: activeToken }, [
        "https://api.test.local/**",
      ]);

      const creds: MitmCredentialSource = {
        current: () => pl,
        deliveryPlans: () => dp,
        shouldReauth: (authKey, status) => authKey === "vendor" && status === 401,
        async refreshOnUnauthorized(authKey) {
          reauthCalls += 1;
          expect(authKey).toBe("vendor");
          // Simulate runConnectLogin → setSessionOutputs swapping the plan.
          activeToken = "fresh";
          dp.vendor = plan("X-Session", activeToken, "");
          return true;
        },
      };

      const recorded = makeRecordingFetch(async (_url, init) => {
        upstreamCallNo += 1;
        const headers = init.headers as Headers;
        const session = headers.get("x-session");
        if (session === "fresh") {
          return new Response(`{"ok":true}`, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(`{"err":"session_expired"}`, { status: 401 });
      });

      const listener = createIntegrationMitmListener({
        caBundle: bundle,
        minter,
        credentials: creds,
        ...permissiveEgress,
        resolveHostFn: stubResolveHost,
        fetch: recorded.fetch,
      });
      await listener.ready;
      try {
        const addr = listener.address();
        const out = await drivenFetch({
          listenerPort: addr.port,
          sni: "api.test.local",
          caCertPem: bundle.pems.caCertPem,
          method: "GET",
          path: "/v1/items",
          headers: {},
        });
        expect(out.status).toBe(200);
        // At-most-one retry: exactly two upstream calls, one reauth.
        expect(upstreamCallNo).toBe(2);
        expect(reauthCalls).toBe(1);
      } finally {
        await listener.close();
      }
    },
  );

  runIfOpenssl("does not retry when the status is outside reauthOn", async () => {
    const bundle = await makeCaBundle();
    const minter = createCertMinter({
      caCertPem: bundle.pems.caCertPem,
      caKeyPem: bundle.pems.caKeyPem,
    });

    let upstreamCallNo = 0;
    let reauthCalls = 0;

    const dp: Record<string, HttpDeliveryPlan> = {
      vendor: plan("X-Session", "stale", ""),
    };
    const pl = payload("vendor", "custom", { session: "stale" }, ["https://api.test.local/**"]);

    const creds: MitmCredentialSource = {
      current: () => pl,
      deliveryPlans: () => dp,
      // Only 401 re-triggers; the upstream returns 403 below.
      shouldReauth: (authKey, status) => authKey === "vendor" && status === 401,
      async refreshOnUnauthorized() {
        reauthCalls += 1;
        return true;
      },
    };

    const recorded = makeRecordingFetch(async () => {
      upstreamCallNo += 1;
      return new Response(`{"err":"forbidden"}`, { status: 403 });
    });

    const listener = createIntegrationMitmListener({
      caBundle: bundle,
      minter,
      credentials: creds,
      ...permissiveEgress,
      resolveHostFn: stubResolveHost,
      fetch: recorded.fetch,
    });
    await listener.ready;
    try {
      const addr = listener.address();
      const out = await drivenFetch({
        listenerPort: addr.port,
        sni: "api.test.local",
        caCertPem: bundle.pems.caCertPem,
        method: "GET",
        path: "/v1/items",
        headers: {},
      });
      expect(out.status).toBe(403);
      expect(upstreamCallNo).toBe(1);
      expect(reauthCalls).toBe(0);
    } finally {
      await listener.close();
    }
  });

  runIfOpenssl(
    "connect.tool auth whose reauth_on EXCLUDES 401: pass-through (no stale replay, no re-login)",
    async () => {
      // A 401 on a connect.tool session whose `reauth_on` deliberately excludes
      // 401: the manifest says 401 is not a session-death signal. The listener
      // must leave it untouched — NOT mistake it for a dead static credential
      // (replay + flag) NOR re-login (which refreshOnUnauthorized would do
      // regardless of status). `hasReloginHandler` distinguishes it from a plain
      // api_key.
      const bundle = await makeCaBundle();
      const minter = createCertMinter({
        caCertPem: bundle.pems.caCertPem,
        caKeyPem: bundle.pems.caKeyPem,
      });

      let upstreamCallNo = 0;
      let reauthCalls = 0;

      const dp: Record<string, HttpDeliveryPlan> = { vendor: plan("X-Session", "stale", "") };
      const pl = payload("vendor", "custom", { session: "stale" }, ["https://api.test.local/**"]);

      const creds: MitmCredentialSource = {
        current: () => pl,
        deliveryPlans: () => dp,
        hasReloginHandler: (authKey) => authKey === "vendor",
        shouldReauth: (authKey, status) => authKey === "vendor" && status === 403, // excludes 401
        async refreshOnUnauthorized() {
          reauthCalls += 1;
          return true;
        },
      };

      const recorded = makeRecordingFetch(async () => {
        upstreamCallNo += 1;
        return new Response(`{"err":"unauthorized"}`, { status: 401 });
      });

      const listener = createIntegrationMitmListener({
        caBundle: bundle,
        minter,
        credentials: creds,
        ...permissiveEgress,
        resolveHostFn: stubResolveHost,
        fetch: recorded.fetch,
      });
      await listener.ready;
      try {
        const out = await drivenFetch({
          listenerPort: listener.address().port,
          sni: "api.test.local",
          caCertPem: bundle.pems.caCertPem,
          method: "GET",
          path: "/v1/items",
          headers: {},
        });
        expect(out.status).toBe(401);
        expect(upstreamCallNo).toBe(1); // pass-through — no replay
        expect(reauthCalls).toBe(0); // no re-login
      } finally {
        await listener.close();
      }
    },
  );

  runIfOpenssl("leaves the original failed response when re-login fails (no loop)", async () => {
    const bundle = await makeCaBundle();
    const minter = createCertMinter({
      caCertPem: bundle.pems.caCertPem,
      caKeyPem: bundle.pems.caKeyPem,
    });

    let upstreamCallNo = 0;
    let reauthCalls = 0;

    const dp: Record<string, HttpDeliveryPlan> = {
      vendor: plan("X-Session", "stale", ""),
    };
    const pl = payload("vendor", "custom", { session: "stale" }, ["https://api.test.local/**"]);

    const creds: MitmCredentialSource = {
      current: () => pl,
      deliveryPlans: () => dp,
      shouldReauth: (authKey, status) => authKey === "vendor" && status === 401,
      async refreshOnUnauthorized() {
        reauthCalls += 1;
        return false; // re-login failed → no retry
      },
    };

    const recorded = makeRecordingFetch(async () => {
      upstreamCallNo += 1;
      return new Response(`{"err":"session_expired"}`, { status: 401 });
    });

    const listener = createIntegrationMitmListener({
      caBundle: bundle,
      minter,
      credentials: creds,
      ...permissiveEgress,
      resolveHostFn: stubResolveHost,
      fetch: recorded.fetch,
    });
    await listener.ready;
    try {
      const addr = listener.address();
      const out = await drivenFetch({
        listenerPort: addr.port,
        sni: "api.test.local",
        caCertPem: bundle.pems.caCertPem,
        method: "GET",
        path: "/v1/items",
        headers: {},
      });
      expect(out.status).toBe(401);
      // refreshOnUnauthorized was attempted once, but the failed result means
      // the original 401 is returned and there is no second upstream call.
      expect(reauthCalls).toBe(1);
      expect(upstreamCallNo).toBe(1);
    } finally {
      await listener.close();
    }
  });
});

describe("MITM listener — telemetry", () => {
  runIfOpenssl("emits connect-accepted and request-forwarded events", async () => {
    const bundle = await makeCaBundle();
    const minter = createCertMinter({
      caCertPem: bundle.pems.caCertPem,
      caKeyPem: bundle.pems.caKeyPem,
    });
    const events: MitmListenerEvent[] = [];

    const creds: MitmCredentialSource = {
      current: () => payload("v", "oauth2", { access_token: "t" }, ["https://api.test.local/**"]),
      deliveryPlans: () => ({ v: plan("Authorization", "t") }),
    };

    const recorded = makeRecordingFetch(async () => new Response("ok", { status: 200 }));

    const listener = createIntegrationMitmListener({
      caBundle: bundle,
      minter,
      credentials: creds,
      ...permissiveEgress,
      resolveHostFn: stubResolveHost,
      fetch: recorded.fetch,
      onEvent: (e) => events.push(e),
    });
    await listener.ready;
    try {
      const addr = listener.address();
      await drivenFetch({
        listenerPort: addr.port,
        sni: "api.test.local",
        caCertPem: bundle.pems.caCertPem,
        method: "GET",
        path: "/",
        headers: {},
      });
      const accepted = events.find((e) => e.kind === "connect-accepted");
      const forwarded = events.find((e) => e.kind === "request-forwarded");
      expect(accepted).toBeDefined();
      expect(forwarded).toBeDefined();
      expect((forwarded as { authKey: string | null }).authKey).toBe("v");
    } finally {
      await listener.close();
    }
  });
});

describe("MITM listener — SSRF floor", () => {
  runIfOpenssl(
    "refuses a CONNECT whose SNI is a blocked target (cloud IMDS) without minting or forwarding",
    async () => {
      const bundle = await makeCaBundle();
      const minter = createCertMinter({
        caCertPem: bundle.pems.caCertPem,
        caKeyPem: bundle.pems.caKeyPem,
      });
      const events: MitmListenerEvent[] = [];
      const creds: MitmCredentialSource = {
        current: () => payload("v", "oauth2", { access_token: "t" }, ["https://**/**"]),
        deliveryPlans: () => ({ v: plan("Authorization", "t") }),
      };
      const recorded = makeRecordingFetch(async () => new Response("ok", { status: 200 }));

      const listener = createIntegrationMitmListener({
        caBundle: bundle,
        minter,
        credentials: creds,
        ...permissiveEgress,
        resolveHostFn: stubResolveHost,
        fetch: recorded.fetch,
        onEvent: (e) => events.push(e),
      });
      await listener.ready;
      try {
        const addr = listener.address();
        // The canonical cloud-metadata hostname — `isBlockedHost` blocks it
        // by literal match. The listener must destroy the socket right after
        // SNI extraction, so the TLS handshake never completes.
        //
        // We send a *hostname* SNI (not an IP literal): TLS SNI carries
        // host_name only (RFC 6066), and `node:tls` refuses to put an IP in
        // the SNI extension, so an IP-literal `servername` would never reach
        // the server's SNI block path at all. A real attacker controls the
        // hostname, so this exercises the SSRF floor faithfully.
        await expect(
          drivenFetch({
            listenerPort: addr.port,
            sni: "metadata.google.internal",
            caCertPem: bundle.pems.caCertPem,
            method: "GET",
            path: "/computeMetadata/v1/instance/service-accounts/default/token",
            headers: {},
          }),
        ).rejects.toThrow();

        expect(events.some((e) => e.kind === "tls-error")).toBe(true);
        // No leaf minted, no upstream fetch — egress never happened.
        expect(recorded.calls.length).toBe(0);
      } finally {
        await listener.close();
      }
    },
  );

  runIfOpenssl(
    "refuses a CONNECT whose SNI is a public-looking name that RESOLVES to a blocked address (DNS rebind)",
    async () => {
      const bundle = await makeCaBundle();
      const minter = createCertMinter({
        caCertPem: bundle.pems.caCertPem,
        caKeyPem: bundle.pems.caKeyPem,
      });
      const events: MitmListenerEvent[] = [];
      const creds: MitmCredentialSource = {
        current: () => payload("v", "oauth2", { access_token: "t" }, ["https://**/**"]),
        deliveryPlans: () => ({ v: plan("Authorization", "t") }),
      };
      const recorded = makeRecordingFetch(async () => new Response("ok", { status: 200 }));

      const listener = createIntegrationMitmListener({
        caBundle: bundle,
        minter,
        credentials: creds,
        ...permissiveEgress,
        resolveHostFn: async () => ["169.254.169.254"],
        fetch: recorded.fetch,
        onEvent: (e) => events.push(e),
      });
      await listener.ready;
      try {
        const addr = listener.address();
        // `rebind.example` passes the LITERAL blocklist, but its A record
        // points at the cloud metadata address — the resolve-and-check layer
        // must destroy the socket before any mint or upstream fetch.
        await expect(
          drivenFetch({
            listenerPort: addr.port,
            sni: "rebind.example",
            caCertPem: bundle.pems.caCertPem,
            method: "GET",
            path: "/latest/meta-data/",
            headers: {},
          }),
        ).rejects.toThrow();

        expect(events.some((e) => e.kind === "tls-error" && /rebind/i.test(e.error))).toBe(true);
        expect(recorded.calls.length).toBe(0);
      } finally {
        await listener.close();
      }
    },
  );

  runIfOpenssl("refuses (fails closed) when SNI host DNS resolution fails", async () => {
    const bundle = await makeCaBundle();
    const minter = createCertMinter({
      caCertPem: bundle.pems.caCertPem,
      caKeyPem: bundle.pems.caKeyPem,
    });
    const events: MitmListenerEvent[] = [];
    const creds: MitmCredentialSource = {
      current: () => payload("v", "oauth2", { access_token: "t" }, ["https://**/**"]),
      deliveryPlans: () => ({ v: plan("Authorization", "t") }),
    };
    const recorded = makeRecordingFetch(async () => new Response("ok", { status: 200 }));

    const listener = createIntegrationMitmListener({
      caBundle: bundle,
      minter,
      credentials: creds,
      ...permissiveEgress,
      resolveHostFn: async () => {
        throw new Error("NXDOMAIN");
      },
      fetch: recorded.fetch,
      onEvent: (e) => events.push(e),
    });
    await listener.ready;
    try {
      const addr = listener.address();
      await expect(
        drivenFetch({
          listenerPort: addr.port,
          sni: "flaky.example",
          caCertPem: bundle.pems.caCertPem,
          method: "GET",
          path: "/",
          headers: {},
        }),
      ).rejects.toThrow();

      expect(events.some((e) => e.kind === "tls-error" && /resolution failed/i.test(e.error))).toBe(
        true,
      );
      expect(recorded.calls.length).toBe(0);
    } finally {
      await listener.close();
    }
  });
});

describe("MITM listener — proxyUrl shape", () => {
  runIfOpenssl("emits a ready-to-use http://host:port URL", async () => {
    const bundle = await makeCaBundle();
    const minter = createCertMinter({
      caCertPem: bundle.pems.caCertPem,
      caKeyPem: bundle.pems.caKeyPem,
    });
    const creds: MitmCredentialSource = {
      current: () => ({ auths: [] }),
      deliveryPlans: () => ({}),
    };
    const listener = createIntegrationMitmListener({
      caBundle: bundle,
      minter,
      credentials: creds,
      ...permissiveEgress,
      resolveHostFn: stubResolveHost,
    });
    await listener.ready;
    try {
      const url = listener.proxyUrl();
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await listener.close();
    }
  });
});

describe("MITM listener — egress allowlist (#1458)", () => {
  async function setup(overrides: Partial<Parameters<typeof createIntegrationMitmListener>[0]>) {
    const bundle = await makeCaBundle();
    const minter = createCertMinter({
      caCertPem: bundle.pems.caCertPem,
      caKeyPem: bundle.pems.caKeyPem,
    });
    const events: MitmListenerEvent[] = [];
    const recorded = makeRecordingFetch(async () => new Response("ok", { status: 200 }));
    const listener = createIntegrationMitmListener({
      caBundle: bundle,
      minter,
      credentials: {
        current: () => payload("v", "oauth2", { access_token: "t" }, ["https://api.test.local/**"]),
        deliveryPlans: () => ({ v: plan("Authorization", "t") }),
      },
      resolveHostFn: stubResolveHost,
      fetch: recorded.fetch,
      onEvent: (e) => events.push(e),
      ...permissiveEgress,
      ...overrides,
    });
    await listener.ready;
    return { listener, caCertPem: bundle.pems.caCertPem, minter, events, calls: recorded.calls };
  }

  /** Status code of the listener's reply to a raw CONNECT (0 when closed silently). */
  function connectStatus(port: number, target: string): Promise<number> {
    return new Promise((resolve) => {
      const sock = netConnect(port, "127.0.0.1", () => {
        sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
      });
      let buf = "";
      sock.on("data", (c: Buffer) => {
        buf += c.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        sock.destroy();
        resolve(Number.parseInt(buf.split(" ")[1] ?? "0", 10));
      });
      sock.on("close", () => resolve(0));
      sock.on("error", () => resolve(0));
    });
  }

  runIfOpenssl("refuses a peer that is not the owning runner before the CONNECT", async () => {
    const peers: string[] = [];
    const { listener, minter, events, calls } = await setup({
      isPeerAllowed: async ({ address }) => {
        peers.push(address);
        return false;
      },
    });
    try {
      const status = await connectStatus(listener.address().port, "api.test.local:443");
      expect(status).toBe(403);
      expect(peers).toEqual(["127.0.0.1"]);
      expect(events).toEqual([
        { kind: "connect-rejected", reason: "peer-not-allowed", peer: "127.0.0.1" },
      ]);
      expect(minter.cacheSize).toBe(0);
      expect(calls.length).toBe(0);
    } finally {
      await listener.close();
    }
  });

  runIfOpenssl("refuses an off-list SNI before minting a cert or resolving it", async () => {
    const authorities: Array<[string, number]> = [];
    const resolved: string[] = [];
    const { listener, caCertPem, minter, events, calls } = await setup({
      egressPolicy: {
        allowsAuthority: (host, port) => {
          authorities.push([host, port]);
          return host === "api.test.local";
        },
        allowsUrl: () => true,
      },
      resolveHostFn: async (host) => {
        resolved.push(host);
        return ["203.0.113.10"];
      },
    });
    try {
      await expect(
        drivenFetch({
          listenerPort: listener.address().port,
          sni: "evil.test.local",
          caCertPem,
          method: "GET",
          path: "/",
          headers: {},
        }),
      ).rejects.toThrow();
      expect(authorities).toEqual([["evil.test.local", 443]]);
      expect(events).toContainEqual({
        kind: "connect-rejected",
        reason: "not-authorized",
        host: "evil.test.local",
        port: 443,
      });
      expect(resolved).toEqual([]);
      expect(minter.cacheSize).toBe(0);
      expect(calls.length).toBe(0);
    } finally {
      await listener.close();
    }
  });

  runIfOpenssl(
    "answers 403 to an off-list URL without reaching upstream, and still injects on-list",
    async () => {
      const { listener, caCertPem, events, calls } = await setup({
        egressPolicy: {
          allowsAuthority: () => true,
          allowsUrl: (url) => url.startsWith("https://api.test.local/allowed/"),
        },
      });
      try {
        const request = (path: string) =>
          drivenFetch({
            listenerPort: listener.address().port,
            sni: "api.test.local",
            caCertPem,
            method: "GET",
            path,
            headers: { Authorization: "Bearer caller-token" },
          });

        const denied = await request("/denied?x=1");
        expect(denied.status).toBe(403);
        expect(calls.length).toBe(0);
        expect(events).toContainEqual({
          kind: "request-refused",
          url: "https://api.test.local/denied?x=1",
          reason: "not-authorized",
        });

        const allowed = await request("/allowed/items");
        expect(allowed.status).toBe(200);
        expect(calls.length).toBe(1);
        expect(calls[0]!.url).toBe("https://api.test.local/allowed/items");
        expect((calls[0]!.init.headers as Headers).get("Authorization")).toBe("Bearer t");
      } finally {
        await listener.close();
      }
    },
  );
  runIfOpenssl(
    "refuses a CONNECT to a port the pattern does not grant instead of forwarding to 443 (#1588)",
    async () => {
      const { listener, caCertPem, minter, events, calls } = await setup({
        egressPolicy: compileEgressPolicy({
          authorizedUris: ["https://api.test.local/**"],
          allowAllUris: false,
        }),
      });
      try {
        await expect(
          drivenFetch({
            listenerPort: listener.address().port,
            sni: "api.test.local",
            port: 8443,
            caCertPem,
            method: "GET",
            path: "/items",
            headers: {},
          }),
        ).rejects.toThrow();
        expect(events).toContainEqual({
          kind: "connect-rejected",
          reason: "not-authorized",
          host: "api.test.local",
          port: 8443,
        });
        expect(minter.cacheSize).toBe(0);
        expect(calls.length).toBe(0);
      } finally {
        await listener.close();
      }
    },
  );

  runIfOpenssl(
    "forwards to the CONNECT port a pattern grants explicitly, and keeps 443 apart (#1588)",
    async () => {
      const authorizedUris = ["https://api.test.local:8443/**", "https://api.test.local/**"];
      const { listener, caCertPem, calls } = await setup({
        egressPolicy: compileEgressPolicy({ authorizedUris, allowAllUris: false }),
        credentials: {
          current: () => payload("v", "oauth2", { access_token: "t" }, authorizedUris),
          deliveryPlans: () => ({ v: plan("Authorization", "t") }),
        },
      });
      try {
        const request = (port: number) =>
          drivenFetch({
            listenerPort: listener.address().port,
            sni: "api.test.local",
            port,
            caCertPem,
            method: "GET",
            path: "/items?page=2",
            headers: {},
          });

        expect((await request(8443)).status).toBe(200);
        expect((await request(443)).status).toBe(200);
        expect(calls.map((c) => c.url)).toEqual([
          "https://api.test.local:8443/items?page=2",
          "https://api.test.local/items?page=2",
        ]);
        const headers = calls.map((c) => c.init.headers as Headers);
        expect(headers.map((h) => h.get("Host"))).toEqual([
          "api.test.local:8443",
          "api.test.local",
        ]);
        expect(headers.map((h) => h.get("Authorization"))).toEqual(["Bearer t", "Bearer t"]);
      } finally {
        await listener.close();
      }
    },
  );
});

describe("MITM listener — per-SNI inner servers are off the loopback", () => {
  /**
   * Inodes of the TCP sockets this process holds in LISTEN (Linux only): an
   * inner server on a loopback port would add one, reachable by every runner
   * and the agent sharing the loopback, with this integration's credentials
   * injected into whatever it relays.
   */
  async function ownTcpListenInodes(): Promise<Set<string>> {
    const own = new Set<string>();
    for (const fd of await fs.readdir("/proc/self/fd")) {
      const target = await fs.readlink(`/proc/self/fd/${fd}`).catch(() => "");
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      if (inode) own.add(inode);
    }
    const listening = new Set<string>();
    for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      const text = await fs.readFile(table, "utf8").catch(() => "");
      for (const line of text.split("\n").slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (fields[3] === "0A" && own.has(fields[9] ?? "")) listening.add(fields[9]!);
      }
    }
    return listening;
  }

  /**
   * Run `body` with `os.tmpdir()` (it reads `TMPDIR` on every call) on a fresh
   * root, so the listener's `mitm-*` socket directory lands where the test can
   * list it.
   */
  async function withTmpRoot(body: (root: string) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(tmpdir(), "mitm-t-"));
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = root;
    try {
      await body(root);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  function newListener(
    bundle: Awaited<ReturnType<typeof makeCaBundle>>,
    options: { host?: string; fetch?: typeof fetch },
  ) {
    return createIntegrationMitmListener({
      caBundle: bundle,
      minter: createCertMinter({
        caCertPem: bundle.pems.caCertPem,
        caKeyPem: bundle.pems.caKeyPem,
      }),
      credentials: {
        current: () => payload("v", "oauth2", { access_token: "t" }, ["https://api.test.local/**"]),
        deliveryPlans: () => ({ v: plan("Authorization", "t") }),
      },
      resolveHostFn: stubResolveHost,
      ...options,
      ...permissiveEgress,
    });
  }

  runIfOpenssl(
    "serves each SNI on a unix socket in a 0700 directory, removed on close",
    async () => {
      // Minted before TMPDIR moves: the CA's work dir lives under `tmpdir()` too.
      const bundle = await makeCaBundle();
      await withTmpRoot(async (root) => {
        const recorded = makeRecordingFetch(async () => new Response("ok", { status: 200 }));
        const listener = newListener(bundle, { fetch: recorded.fetch });
        await listener.ready;
        // The cert minter stages its own work dir under `tmpdir()` at the first
        // mint; only the `mitm-*` directory is the listener's.
        const socketDirs = async () =>
          (await fs.readdir(root)).filter((name) => name.startsWith("mitm-"));
        try {
          const [dirName, ...others] = await socketDirs();
          expect(dirName).toBeDefined();
          expect(others).toEqual([]);
          const dir = path.join(root, dirName!);
          expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
          const linux = process.platform === "linux";
          const listenersBefore = linux ? await ownTcpListenInodes() : new Set<string>();

          const out = await drivenFetch({
            listenerPort: listener.address().port,
            sni: "api.test.local",
            caCertPem: bundle.pems.caCertPem,
            method: "GET",
            path: "/items",
            headers: {},
          });
          // Relayed through the inner server, credential injected.
          expect(out.status).toBe(200);
          expect((recorded.calls[0]!.init.headers as Headers).get("Authorization")).toBe(
            "Bearer t",
          );

          const [socketName, ...moreSockets] = await fs.readdir(dir);
          expect(moreSockets).toEqual([]);
          expect((await fs.stat(path.join(dir, socketName!))).isSocket()).toBe(true);
          if (linux) expect(await ownTcpListenInodes()).toEqual(listenersBefore);
        } finally {
          await listener.close();
        }
        expect(await socketDirs()).toEqual([]);
      });
    },
  );

  runIfOpenssl("rejects `ready` when the listen fails, leaving no socket directory", async () => {
    const bundle = await makeCaBundle();
    await withTmpRoot(async (root) => {
      // A 64-byte label cannot be encoded as a DNS name (RFC 1035 caps labels at
      // 63), so resolution fails before any query or bind (glibc, musl, macOS),
      // where an unassigned address would still bind under `ip_nonlocal_bind`.
      const host = `${"a".repeat(64)}.invalid`;
      const listener = newListener(bundle, { host });
      const failure = await listener.ready.then(
        () => null,
        (err: unknown) => err,
      );
      // Never leave a listener behind, even if the host somehow resolved.
      if (failure === null) await listener.close();
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(host);
      expect(await fs.readdir(root)).toEqual([]);
    });
  });
});
