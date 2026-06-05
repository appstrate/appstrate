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

function plan(headerName: string, value: string, prefix = "Bearer"): HttpDeliveryPlan {
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
      raw.write(`CONNECT ${opts.sni}:443 HTTP/1.1\r\nHost: ${opts.sni}:443\r\n\r\n`);
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

  runIfOpenssl(
    "api_key persistent 401: same-credential retry, THEN /refresh (to flag), no rotate-retry",
    async () => {
      // A 401 on an injected api_key credential first replays the SAME request
      // once (a 401 may be a transient blip). The replay also 401s here → the
      // listener reaches the platform `/refresh` (which flags the connection —
      // modelled by the source returning false). Since there is no token to
      // rotate, the request is not replayed a third time.
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
        expect(upstreamCallNo).toBe(2); // original + one same-credential replay
        expect(refreshCalls).toBe(1); // replay still 401 → /refresh reached (to flag)
      } finally {
        await listener.close();
      }
    },
  );

  runIfOpenssl(
    "api_key transient 401: same-credential retry succeeds → NO /refresh, not flagged",
    async () => {
      // The first response is a transient 401 (upstream blip); the same-request
      // replay succeeds. The listener must NOT reach `/refresh` — a still-good
      // key would be wrongly flagged needsReconnection.
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
          return false;
        },
      };

      const recorded = makeRecordingFetch(async () => {
        upstreamCallNo += 1;
        return upstreamCallNo === 1
          ? new Response(`{"err":"unauthorized"}`, { status: 401 })
          : new Response(`{"ok":true}`, { status: 200 });
      });

      const listener = createIntegrationMitmListener({
        caBundle: bundle,
        minter,
        credentials: creds,
        fetch: recorded.fetch,
      });
      await listener.ready;
      try {
        const out = await drivenFetch({
          listenerPort: listener.address().port,
          sni: "api.test.local",
          caCertPem: bundle.pems.caCertPem,
          method: "GET",
          path: "/",
          headers: {},
        });
        expect(out.status).toBe(200); // recovered on the same-credential replay
        expect(upstreamCallNo).toBe(2); // original + one replay
        expect(refreshCalls).toBe(0); // never reached /refresh → not flagged
      } finally {
        await listener.close();
      }
    },
  );

  runIfOpenssl(
    "api_key POST 401: NOT replayed (non-idempotent) but /refresh still flags",
    async () => {
      // RFC 9110: never re-issue a POST with the same credential. The same-cred
      // transient replay is skipped, but a persistent-credential POST 401 still
      // routes to /refresh (modelled by the source returning false) to flag.
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
          return false;
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
        fetch: recorded.fetch,
      });
      await listener.ready;
      try {
        const out = await drivenFetch({
          listenerPort: listener.address().port,
          sni: "api.test.local",
          caCertPem: bundle.pems.caCertPem,
          method: "POST",
          path: "/v1/items",
          headers: {},
        });
        expect(out.status).toBe(401);
        expect(upstreamCallNo).toBe(1); // no same-credential replay for POST
        expect(refreshCalls).toBe(1); // /refresh still reached (to flag)
      } finally {
        await listener.close();
      }
    },
  );

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
        fetch: recorded.fetch,
        onEvent: (e) => events.push(e),
      });
      await listener.ready;
      try {
        const addr = listener.address();
        // The link-local cloud metadata address — `isBlockedHost` blocks
        // 169.254.0.0/16. The listener must destroy the socket right after
        // SNI extraction, so the TLS handshake never completes.
        await expect(
          drivenFetch({
            listenerPort: addr.port,
            sni: "169.254.169.254",
            caCertPem: bundle.pems.caCertPem,
            method: "GET",
            path: "/latest/meta-data/iam/security-credentials/",
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
