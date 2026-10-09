// SPDX-License-Identifier: Apache-2.0

/**
 * Plain egress listener (#543).
 *
 * Proves the no-injection egress path: a CONNECT tunnel to an allowed host
 * relays raw bytes (NO TLS termination, NO cert mint), the SSRF floor refuses
 * internal / cloud-metadata targets, and the hard allowlist (#1458) gates by
 * peer, by `host:port` and by the SNI a TLS tunnel carries. Absolute-form
 * `http://` requests are vetted one by one the same way and forwarded
 * origin-form (#1819); any other non-CONNECT request is rejected.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { createServer as createHttpServer } from "node:http";
import type { IncomingHttpHeaders, Server as HttpServer } from "node:http";
import { createServer as netCreateServer, connect as netConnect } from "node:net";
import type { Server as NetServer } from "node:net";

import {
  createIntegrationEgressListener,
  type EgressListenerEvent,
} from "../integration-egress-listener.ts";
import type { MitmListenerHandle } from "../integration-mitm-listener.ts";
import { compileRunnerEgressPolicy } from "../ssrf.ts";
import { privateIpv4 } from "./helpers/private-ipv4.ts";
import { buildClientHello, tlsRecord } from "./helpers/tls-client-hello.ts";

const listeners: MitmListenerHandle[] = [];
const tcpServers: NetServer[] = [];
/** Their connections from the listener's upstream agent are kept alive: closed at cleanup. */
const httpServers: HttpServer[] = [];

// A server's close() waits for its open connections, so a connection the listener
// leaves half-open would hang this hook: fail it fast instead, and take the handles
// out first so one leak cannot stall every later test's cleanup.
afterEach(async () => {
  const closing = Promise.all([
    ...listeners.splice(0).map((l) => l.close().catch(() => {})),
    ...tcpServers.splice(0).map((s) => new Promise<void>((res) => s.close(() => res()))),
    ...httpServers.splice(0).map((s) => {
      s.closeAllConnections();
      return new Promise<void>((res) => s.close(() => res()));
    }),
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const leaked = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("a connection outlived its test")), 2_000);
  });
  await Promise.race([closing, leaked]).finally(() => clearTimeout(timer));
});

/**
 * A raw TCP echo server on `host` — stands in for an upstream the runner tunnels
 * to. Records every byte it receives; `closed` settles when a connection ends.
 */
function startTcpEcho(
  host = "127.0.0.1",
): Promise<{ port: number; received: Buffer[]; closed: Promise<void> }> {
  const received: Buffer[] = [];
  let markClosed!: () => void;
  const closed = new Promise<void>((res) => (markClosed = res));
  return new Promise((resolve) => {
    const server = netCreateServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        received.push(chunk);
        socket.write(chunk);
      });
      socket.on("error", () => socket.destroy());
      socket.on("close", () => markClosed());
    });
    tcpServers.push(server);
    server.listen(0, host, () => {
      const addr = server.address();
      resolve({ port: typeof addr === "object" && addr ? addr.port : 0, received, closed });
    });
  });
}

/** A server-speaks-first upstream (SMTP-style): banner on accept, records what it receives. */
function startBannerServer(
  banner: string,
): Promise<{ port: number; received: () => string; gotData: Promise<void> }> {
  let received = "";
  let markGot!: () => void;
  const gotData = new Promise<void>((res) => (markGot = res));
  return new Promise((resolve) => {
    const server = netCreateServer((socket) => {
      socket.write(banner);
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString();
        markGot();
      });
      socket.on("error", () => socket.destroy());
    });
    tcpServers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : 0,
        received: () => received,
        gotData,
      });
    });
  });
}

interface UpstreamRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * A keep-alive HTTP/1.1 upstream on `host` recording every request it gets and counting the
 * connections it accepts; it answers each one `ok`, after `delayMs(url)`.
 */
function startHttpUpstream(
  host = "127.0.0.1",
  delayMs: (url: string) => number = () => 0,
): Promise<{ port: number; requests: UpstreamRequest[]; connections: () => number }> {
  const requests: UpstreamRequest[] = [];
  let connections = 0;
  return new Promise((resolve) => {
    const server = createHttpServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("latin1")));
      req.on("end", () => {
        requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        setTimeout(() => res.end("ok"), delayMs(req.url ?? ""));
      });
    });
    server.on("connection", () => connections++);
    httpServers.push(server);
    server.listen(0, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, requests, connections: () => connections });
    });
  });
}

/** Write `chunks` to the proxy 20 ms apart; resolves with everything it answers, at close. */
function exchange(proxyPort: number, chunks: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let response = "";
    const socket = netConnect(proxyPort, "127.0.0.1", () => {
      chunks.forEach((chunk, i) => setTimeout(() => socket.write(chunk), i * 20));
    });
    socket.on("data", (chunk: Buffer) => (response += chunk.toString("latin1")));
    socket.on("error", () => {}); // a reset surfaces as `close`
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(response);
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("exchange timeout"));
    }, 5000);
  });
}

/**
 * Send `requests` on ONE connection, each once the previous answer is complete (all at once when
 * `pipelined`); resolves with every answer, or those received before the connection closed.
 */
function keepAliveExchange(
  proxyPort: number,
  requests: string[],
  pipelined = false,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const responses: string[] = [];
    let buf = "";
    const socket = netConnect(proxyPort, "127.0.0.1", () => {
      socket.write(pipelined ? requests.join("") : requests[0]!);
    });
    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(responses);
    };
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      for (;;) {
        const headEnd = buf.indexOf("\r\n\r\n");
        if (headEnd === -1) return;
        const length = Number(/\r\ncontent-length: *(\d+)/i.exec(buf.slice(0, headEnd))?.[1] ?? 0);
        if (buf.length < headEnd + 4 + length) return;
        responses.push(buf.slice(0, headEnd + 4 + length));
        buf = buf.slice(headEnd + 4 + length);
        if (responses.length === requests.length) return finish();
        if (!pipelined) socket.write(requests[responses.length]!);
      }
    });
    socket.on("error", () => {}); // a reset surfaces as `close`
    socket.on("close", finish);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("keep-alive exchange timeout"));
    }, 5000);
  });
}

const statusOf = (response: string) => parseInt(response.split(" ")[1] ?? "0");

const connectTo = (target: string) => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;

/**
 * Write `head` (chunks 20 ms apart), then — once a 200 lands — `segments`
 * (20 ms apart). Resolves with the status and whatever came back through the
 * tunnel once every written byte has echoed, or the tunnel closes.
 */
function tunnel(
  proxyPort: number,
  head: string[],
  segments: Buffer[] = [],
): Promise<{ statusCode: number; echoed: Buffer }> {
  const expected = segments.reduce((n, seg) => n + seg.length, 0);
  return new Promise((resolve, reject) => {
    const socket = netConnect(proxyPort, "127.0.0.1", () => {
      head.forEach((chunk, i) => setTimeout(() => socket.write(chunk), i * 20));
    });
    let buf = "";
    let statusCode = 0;
    const echoed: Buffer[] = [];
    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ statusCode, echoed: Buffer.concat(echoed) });
    };
    socket.on("data", (chunk: Buffer) => {
      if (statusCode === 0) {
        buf += chunk.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        statusCode = parseInt(buf.split(" ")[1] ?? "0");
        if (statusCode !== 200) return finish();
        segments.forEach((seg, i) => setTimeout(() => socket.write(seg), i * 20));
        return;
      }
      echoed.push(chunk);
      if (Buffer.concat(echoed).length >= expected && expected > 0) finish();
    });
    socket.on("close", finish);
    socket.on("error", () => {}); // a reset surfaces as `close`
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("tunnel timeout"));
    }, 5000);
  });
}

/** CONNECT to `target`; once established, write `probe` and collect its echo. */
async function connectAndProbe(
  proxyPort: number,
  target: string,
  probe?: string,
): Promise<{ statusCode: number; echoed: string }> {
  const res = await tunnel(proxyPort, [connectTo(target)], probe ? [Buffer.from(probe)] : []);
  return { statusCode: res.statusCode, echoed: res.echoed.toString() };
}

function makeListener(
  overrides: Partial<Parameters<typeof createIntegrationEgressListener>[0]> = {},
): Promise<{ handle: MitmListenerHandle; events: EgressListenerEvent[] }> {
  const events: EgressListenerEvent[] = [];
  const handle = createIntegrationEgressListener({
    host: "127.0.0.1",
    // Allow loopback by default so the echo server is reachable in tests.
    isBlockedHostFn: () => false,
    onEvent: (e) => events.push(e),
    // Permissive by default; the allowlist tests below override these.
    egressPolicy: { allowsAuthority: () => true, skipsSsrfFloor: () => false },
    isPeerAllowed: async () => true,
    ...overrides,
  });
  listeners.push(handle);
  return handle.ready.then(() => ({ handle, events }));
}

describe("integration-egress-listener (#543)", () => {
  it("relays a CONNECT tunnel to an allowed host (no TLS termination)", async () => {
    const echo = await startTcpEcho();
    const { handle, events } = await makeListener();
    const port = handle.address().port;

    // A non-TLS first byte is relayed as-is: SNI vetting only applies to a ClientHello.
    const res = await connectAndProbe(port, `127.0.0.1:${echo.port}`, "ping");
    expect(res.statusCode).toBe(200);
    expect(res.echoed).toBe("ping");
    expect(events.some((e) => e.kind === "tunnel-opened")).toBe(true);
  });

  it("refuses an SSRF target at CONNECT (cloud metadata)", async () => {
    // Use the REAL SSRF predicate for this one.
    const { handle, events } = await makeListener({ isBlockedHostFn: undefined });
    const port = handle.address().port;

    const res = await connectAndProbe(port, "169.254.169.254:80");
    expect(res.statusCode).toBe(403);
    expect(events.some((e) => e.kind === "tunnel-refused" && e.reason === "ssrf")).toBe(true);
  });

  it("refuses RFC1918 at CONNECT with the real SSRF floor", async () => {
    const { handle } = await makeListener({ isBlockedHostFn: undefined });
    const port = handle.address().port;
    const res = await connectAndProbe(port, "10.0.0.5:443");
    expect(res.statusCode).toBe(403);
  });

  it("refuses a DNS name that RESOLVES to a blocked address (rebind) with the real SSRF floor", async () => {
    // `rebind.example` passes the literal blocklist, but its A record points
    // inside — the resolve-and-pin layer must refuse before any tunnel opens.
    const { handle, events } = await makeListener({
      isBlockedHostFn: undefined,
      resolveHostFn: async () => ["10.0.0.5"],
    });
    const port = handle.address().port;
    const res = await connectAndProbe(port, "rebind.example:443");
    expect(res.statusCode).toBe(403);
    expect(events.some((e) => e.kind === "tunnel-refused" && e.reason === "ssrf")).toBe(true);
  });

  it("refuses when ANY resolved record is blocked (mixed A records)", async () => {
    const { handle } = await makeListener({
      isBlockedHostFn: undefined,
      resolveHostFn: async () => ["93.184.216.34", "169.254.169.254"],
    });
    const port = handle.address().port;
    const res = await connectAndProbe(port, "rebind.example:443");
    expect(res.statusCode).toBe(403);
  });

  it("refuses (fails closed) when DNS resolution fails", async () => {
    const { handle, events } = await makeListener({
      isBlockedHostFn: undefined,
      resolveHostFn: async () => {
        throw new Error("NXDOMAIN");
      },
    });
    const port = handle.address().port;
    const res = await connectAndProbe(port, "nxdomain.example:443");
    expect(res.statusCode).toBe(403);
    expect(
      events.some((e) => e.kind === "tunnel-refused" && e.reason === "dns-resolution-failed"),
    ).toBe(true);
  });

  it("connects to the PINNED resolved IP for an allowed DNS name", async () => {
    const echo = await startTcpEcho();
    // `pinned.example` does NOT resolve in real DNS — the tunnel can only
    // open if the listener connects to the injected resolver's answer, which
    // proves the pin (a name-based connect would fail resolution).
    const { handle, events } = await makeListener({
      resolveHostFn: async () => ["127.0.0.1"],
    });
    const port = handle.address().port;

    const res = await connectAndProbe(port, `pinned.example:${echo.port}`, "ping");
    expect(res.statusCode).toBe(200);
    expect(res.echoed).toBe("ping");
    expect(events.some((e) => e.kind === "tunnel-opened")).toBe(true);
  });

  it("relays when the CONNECT request line is split across TCP segments", async () => {
    const echo = await startTcpEcho();
    const { handle, events } = await makeListener();
    // The verb lands in one segment, the rest (incl. the CRLF) in the next.
    const request = connectTo(`127.0.0.1:${echo.port}`);
    const res = await tunnel(
      handle.address().port,
      [request.slice(0, 4), request.slice(4)],
      [Buffer.from("ping")],
    );

    expect(res.statusCode).toBe(200);
    expect(res.echoed.toString()).toBe("ping");
    expect(events.some((e) => e.kind === "tunnel-opened")).toBe(true);
  });

  it("answers 400 to a CONNECT port that is not 1-65535 in digits, and keeps serving", async () => {
    const echo = await startTcpEcho();
    const { handle, events } = await makeListener();
    const port = handle.address().port;

    for (const badPort of ["0", "70000", "-1", "abc"]) {
      expect((await connectAndProbe(port, `example.com:${badPort}`)).statusCode).toBe(400);
    }
    expect(events).toEqual([]);
    const res = await connectAndProbe(port, `127.0.0.1:${echo.port}`, "ping");
    expect(res.statusCode).toBe(200);
    expect(res.echoed).toBe("ping");
  });

  it("tunnels past the preamble deadline when DNS is slow: it bounds the head only", async () => {
    const echo = await startTcpEcho();
    const { handle } = await makeListener({
      preambleTimeoutMs: 300,
      resolveHostFn: () =>
        new Promise<string[]>((res) => setTimeout(() => res(["127.0.0.1"]), 600)),
    });
    const res = await connectAndProbe(handle.address().port, `slow.example:${echo.port}`, "ping");
    expect(res.statusCode).toBe(200);
    expect(res.echoed).toBe("ping");
  });

  it("refuses a host the egress policy does not grant, before resolving it", async () => {
    const echo = await startTcpEcho();
    let resolved = false;
    const { handle, events } = await makeListener({
      egressPolicy: {
        allowsAuthority: (h) => h === "allowed.example.com",
        skipsSsrfFloor: () => false,
      },
      resolveHostFn: async () => {
        resolved = true;
        return ["127.0.0.1"];
      },
    });
    const port = handle.address().port;

    // Passes the (stubbed) SSRF floor but fails the allowlist.
    const res = await connectAndProbe(port, `denied.example.com:${echo.port}`);
    expect(res.statusCode).toBe(403);
    expect(resolved).toBe(false);
    expect(events.some((e) => e.kind === "tunnel-refused" && e.reason === "not-authorized")).toBe(
      true,
    );
  });

  it("refuses an allowed host on a port the egress policy does not grant", async () => {
    const echo = await startTcpEcho();
    const seen: Array<[string, number]> = [];
    const { handle, events } = await makeListener({
      egressPolicy: {
        allowsAuthority: (h, p) => {
          seen.push([h, p]);
          return h === "allowed.example.com" && p === 443;
        },
        skipsSsrfFloor: () => false,
      },
      resolveHostFn: async () => ["127.0.0.1"],
    });
    const port = handle.address().port;

    const res = await connectAndProbe(port, `allowed.example.com:${echo.port}`, "ping");
    expect(res.statusCode).toBe(403);
    expect(seen).toEqual([["allowed.example.com", echo.port]]);
    expect(events.some((e) => e.kind === "tunnel-refused" && e.reason === "not-authorized")).toBe(
      true,
    );
  });

  it("refuses a peer that is not the owning runner, before parsing its CONNECT", async () => {
    const echo = await startTcpEcho();
    const peers: string[] = [];
    let policyConsulted = false;
    const { handle, events } = await makeListener({
      isPeerAllowed: async ({ address }) => {
        peers.push(address);
        return false;
      },
      egressPolicy: {
        allowsAuthority: () => {
          policyConsulted = true;
          return true;
        },
        skipsSsrfFloor: () => false,
      },
    });

    const res = await connectAndProbe(handle.address().port, `127.0.0.1:${echo.port}`, "ping");
    expect(res.statusCode).toBe(403);
    expect(peers).toEqual(["127.0.0.1"]);
    expect(policyConsulted).toBe(false);
    expect(events).toContainEqual({
      kind: "tunnel-refused",
      target: "<unknown>",
      reason: "peer-not-allowed",
      peer: "127.0.0.1",
    });
    expect(events.some((e) => e.kind === "tunnel-opened")).toBe(false);
  });

  it("refuses (fails closed) when the peer check throws", async () => {
    const echo = await startTcpEcho();
    const { handle, events } = await makeListener({
      isPeerAllowed: async () => {
        throw new Error("docker inspect failed");
      },
    });
    const res = await connectAndProbe(handle.address().port, `127.0.0.1:${echo.port}`);
    expect(res.statusCode).toBe(403);
    expect(events.some((e) => e.reason === "peer-not-allowed")).toBe(true);
  });

  describe("absolute-form http:// requests (#1819)", () => {
    /** A request head; a `Host` (HTTP/1.1 requires one) and `Connection: close` unless given. */
    const get = (url: string, headers: string[] = []) => {
      const given = (name: string) => headers.some((h) => h.toLowerCase().startsWith(name));
      const defaults = [
        ...(given("host:") ? [] : ["Host: example.com"]),
        ...(given("connection:") ? [] : ["Connection: close"]),
      ];
      return [`GET ${url} HTTP/1.1`, ...headers, ...defaults, "", ""].join("\r\n");
    };

    it("forwards origin-form to the pinned address: URL Host, no hop-by-hop or proxy header", async () => {
      const upstream = await startHttpUpstream();
      const { handle, events } = await makeListener({ resolveHostFn: async () => ["127.0.0.1"] });
      const authority = `app.example:${upstream.port}`;

      const response = await exchange(handle.address().port, [
        get(`http://${authority}/path?q=1`, [
          "Host: vhost.other.example", // replaced by the URL authority (RFC 9112 §3.2.2)
          "Proxy-Connection: keep-alive",
          "Proxy-Authorization: Basic dXNlcjpwdw==",
          "Connection: close, X-Hop",
          "X-Hop: 1",
          "X-Keep: 1",
        ]),
      ]);

      expect(statusOf(response)).toBe(200);
      expect(response.endsWith("\r\n\r\nok")).toBe(true);
      expect(upstream.requests).toHaveLength(1);
      const [request] = upstream.requests;
      expect(request?.url).toBe("/path?q=1");
      expect(request?.headers.host).toBe(authority);
      expect(request?.headers["x-keep"]).toBe("1");
      for (const name of ["proxy-connection", "proxy-authorization", "x-hop"]) {
        expect(request?.headers[name]).toBeUndefined();
      }
      expect(events).toContainEqual({ kind: "tunnel-opened", target: authority });
    });

    it("forwards the path and query byte for byte", async () => {
      const upstream = await startHttpUpstream();
      const { handle } = await makeListener({ resolveHostFn: async () => ["127.0.0.1"] });
      const authority = `app.example:${upstream.port}`;
      const cases: Array<[string, string]> = [
        ["/a/%2e%2e/b?x='y'&z=<w>", "/a/%2e%2e/b?x='y'&z=<w>"],
        ["/a/../b/./c", "/a/../b/./c"],
        ["?q=%41", "/?q=%41"],
      ];

      for (const [sent] of cases) {
        const response = await exchange(handle.address().port, [get(`http://${authority}${sent}`)]);
        expect(statusOf(response)).toBe(200);
      }
      expect(upstream.requests.map((r) => r.url)).toEqual(cases.map(([, received]) => received));
    });

    it("relays a request body intact, past the head and across segments", async () => {
      const upstream = await startHttpUpstream();
      const { handle } = await makeListener();
      const authority = `127.0.0.1:${upstream.port}`;
      const body = "a=1&b=" + "x".repeat(2000);
      const head = [
        `POST http://${authority}/submit HTTP/1.1`,
        `Host: ${authority}`,
        `Content-Length: ${body.length}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n");

      const response = await exchange(handle.address().port, [
        head + body.slice(0, 10),
        body.slice(10),
      ]);
      expect(statusOf(response)).toBe(200);
      expect(upstream.requests.map((r) => [r.method, r.url, r.body])).toEqual([
        ["POST", "/submit", body],
      ]);
    });

    it("refuses a host or port the egress policy does not grant, before resolving it", async () => {
      const upstream = await startHttpUpstream();
      let resolved = false;
      const { handle, events } = await makeListener({
        egressPolicy: {
          allowsAuthority: (h, p) => h === "allowed.example.com" && p === 80,
          skipsSsrfFloor: () => false,
        },
        resolveHostFn: async () => {
          resolved = true;
          return ["127.0.0.1"];
        },
      });

      for (const authority of [
        `denied.example.com:${upstream.port}`,
        `allowed.example.com:${upstream.port}`,
      ]) {
        const response = await exchange(handle.address().port, [get(`http://${authority}/`)]);
        expect(statusOf(response)).toBe(403);
        expect(events).toContainEqual({
          kind: "tunnel-refused",
          target: authority,
          reason: "not-authorized",
        });
      }
      expect(resolved).toBe(false);
      expect(upstream.requests).toHaveLength(0);
    });

    it("refuses SSRF targets with the real floor: literal and DNS rebind", async () => {
      const { handle, events } = await makeListener({
        isBlockedHostFn: undefined,
        resolveHostFn: async () => ["10.0.0.5"],
      });
      for (const url of [
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.5:8080/",
        "http://rebind.example/",
      ]) {
        const response = await exchange(handle.address().port, [get(url)]);
        expect(statusOf(response)).toBe(403);
      }
      expect(events.filter((e) => e.reason === "ssrf")).toHaveLength(3);
      expect(events.some((e) => e.kind === "tunnel-opened")).toBe(false);
    });

    it("answers 502 when the vetted upstream cannot be reached", async () => {
      const deadPort = await new Promise<number>((resolve) => {
        const server = netCreateServer().listen(0, "127.0.0.1", () => {
          const addr = server.address();
          server.close(() => resolve(typeof addr === "object" && addr ? addr.port : 0));
        });
      });
      const { handle, events } = await makeListener();
      const authority = `127.0.0.1:${deadPort}`;

      const response = await exchange(handle.address().port, [get(`http://${authority}/`)]);
      expect(statusOf(response)).toBe(502);
      expect(events.some((e) => e.kind === "tunnel-error" && e.target === authority)).toBe(true);
    });

    it("refuses a peer that is not the owning runner: no policy, no lookup, no upstream", async () => {
      const upstream = await startHttpUpstream();
      let consulted = false;
      const { handle, events } = await makeListener({
        isPeerAllowed: async () => false,
        egressPolicy: {
          allowsAuthority: () => (consulted = true),
          skipsSsrfFloor: () => (consulted = true),
        },
        resolveHostFn: async () => {
          consulted = true;
          return ["127.0.0.1"];
        },
      });

      const authority = `app.example:${upstream.port}`;
      const response = await exchange(handle.address().port, [get(`http://${authority}/`)]);
      expect(statusOf(response)).toBe(403);
      expect(consulted).toBe(false);
      expect(upstream.connections()).toBe(0);
      expect(events).toEqual([
        {
          kind: "tunnel-refused",
          target: "<unknown>",
          reason: "peer-not-allowed",
          peer: "127.0.0.1",
        },
      ]);
    });

    it("strips hop-by-hop headers from the response as well", async () => {
      const server = createHttpServer((_req, res) => {
        res.writeHead(200, {
          connection: "close, x-up-hop",
          "x-up-hop": "1",
          "proxy-authenticate": "Basic",
          "x-up-keep": "1",
          "content-length": "2",
        });
        res.end("ok");
      });
      httpServers.push(server);
      await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
      const { port } = server.address() as { port: number };
      const { handle } = await makeListener();

      const response = await exchange(handle.address().port, [get(`http://127.0.0.1:${port}/`)]);
      const head = response.slice(0, response.indexOf("\r\n\r\n")).toLowerCase();
      expect(statusOf(response)).toBe(200);
      expect(head).toContain("\r\nx-up-keep: 1");
      expect(head).not.toContain("x-up-hop");
      expect(head).not.toContain("proxy-authenticate");
    });

    it("answers 502 to an upstream switching protocols, and drops the upstream socket", async () => {
      let upstreamClosed!: Promise<void>;
      const server = netCreateServer((socket) => {
        socket.on("error", () => {});
        upstreamClosed = new Promise((res) => socket.once("close", () => res()));
        socket.once("data", () =>
          socket.write(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
          ),
        );
      });
      tcpServers.push(server);
      await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
      const { port } = server.address() as { port: number };
      const { handle, events } = await makeListener();

      const response = await exchange(handle.address().port, [get(`http://127.0.0.1:${port}/`)]);
      expect(statusOf(response)).toBe(502);
      await upstreamClosed;
      expect(events.some((e) => e.kind === "tunnel-error")).toBe(true);
    });

    it("drops the upstream request when the client leaves mid-answer", async () => {
      let markClosed!: () => void;
      const upstreamClosed = new Promise<void>((res) => (markClosed = res));
      const server = createHttpServer((_req, res) => {
        res.writeHead(200);
        const streaming = setInterval(() => res.write("x"), 20);
        res.once("close", () => {
          clearInterval(streaming);
          markClosed();
        });
      });
      httpServers.push(server);
      await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
      const { port } = server.address() as { port: number };
      const { handle } = await makeListener();

      const client = netConnect(handle.address().port, "127.0.0.1", () =>
        client.write(get(`http://127.0.0.1:${port}/`)),
      );
      client.on("error", () => {});
      await new Promise((res) => client.once("data", res));
      client.destroy();
      const outcome = await Promise.race([
        upstreamClosed.then(() => "closed"),
        new Promise((res) => setTimeout(() => res("still streaming"), 1000)),
      ]);
      expect(outcome).toBe("closed");
    });

    it("shares no upstream connection between two runners' listeners", async () => {
      const upstream = await startHttpUpstream();
      const resolveHostFn = async () => ["127.0.0.1"];
      const runners = [
        await makeListener({ resolveHostFn }),
        await makeListener({ resolveHostFn }),
      ];
      const url = `http://app.example:${upstream.port}/`;

      for (const { handle } of runners) {
        expect(statusOf(await exchange(handle.address().port, [get(url)]))).toBe(200);
      }
      expect(upstream.connections()).toBe(2);
    });

    it("answers 405 to origin-form and https:// absolute-form requests", async () => {
      const { handle, events } = await makeListener();
      for (const request of [
        get("/", ["Host: example.com"]),
        get("https://example.com/", ["Host: example.com"]),
      ]) {
        expect(statusOf(await exchange(handle.address().port, [request]))).toBe(405);
      }
      expect(events).toEqual([]);
    });

    it("answers 400 to an oversized or malformed head, userinfo or a bad port", async () => {
      const { handle, events } = await makeListener();
      const port = handle.address().port;
      for (const request of [
        get("http://127.0.0.1:9/", [`X-Big: ${"a".repeat(20_000)}`]),
        get("http://127.0.0.1:9/", ["Host: 127.0.0.1:9", " folded"]),
        get("http://127.0.0.1:9/", ["Host : 127.0.0.1:9"]),
        get("http://user:pw@127.0.0.1:9/"),
        get("http://127.0.0.1:99999/"),
        get("http://127.0.0.1:0/"),
      ]) {
        expect(statusOf(await exchange(port, [request]))).toBe(400);
      }
      expect(events).toEqual([]);
    });

    it("closes a connection whose request head never completes, at the preamble deadline", async () => {
      const { handle, events } = await makeListener({ preambleTimeoutMs: 200 });
      const partial = "GET http://127.0.0.1:9/ HTTP/1.1\r\nX-Partial: 1";
      expect(await exchange(handle.address().port, [partial])).toBe("");
      expect(events).toEqual([]);
    });

    describe("every request on a kept-alive connection is vetted", () => {
      const keepAlive = (authority: string, path: string) =>
        get(`http://${authority}${path}`, ["Connection: keep-alive"]);

      for (const [mode, pipelined] of [
        ["in turn", false],
        ["pipelined", true],
      ] as const) {
        it(`refuses an unauthorized one after a served one (${mode})`, async () => {
          const upstream = await startHttpUpstream();
          const { handle, events } = await makeListener({
            egressPolicy: {
              allowsAuthority: (h) => h === "allowed.example",
              skipsSsrfFloor: () => false,
            },
            resolveHostFn: async () => ["127.0.0.1"],
          });
          const allowed = `allowed.example:${upstream.port}`;
          const denied = `denied.example:${upstream.port}`;

          const responses = await keepAliveExchange(
            handle.address().port,
            [keepAlive(allowed, "/first"), keepAlive(denied, "/second")],
            pipelined,
          );
          expect(responses.map(statusOf)).toEqual([200, 403]);
          expect(upstream.requests.map((r) => r.url)).toEqual(["/first"]);
          expect(events).toContainEqual({
            kind: "tunnel-refused",
            target: denied,
            reason: "not-authorized",
          });
        });
      }

      it("keeps the head deadline off while a pipelined request is still in flight", async () => {
        const delayMs = (url: string) => (url === "/slow" ? 600 : 0);
        const upstream = await startHttpUpstream("127.0.0.1", delayMs);
        const { handle } = await makeListener({
          preambleTimeoutMs: 200,
          resolveHostFn: async () => ["127.0.0.1"],
        });
        const authority = `app.example:${upstream.port}`;

        const responses = await keepAliveExchange(
          handle.address().port,
          [keepAlive(authority, "/fast"), keepAlive(authority, "/slow")],
          true,
        );
        expect(responses.map(statusOf)).toEqual([200, 200]);
      });

      it("serves an authorized one for another host, with its own Host", async () => {
        const upstream = await startHttpUpstream();
        const { handle } = await makeListener({ resolveHostFn: async () => ["127.0.0.1"] });
        const first = `allowed.example:${upstream.port}`;
        const second = `other.example:${upstream.port}`;

        const responses = await keepAliveExchange(handle.address().port, [
          keepAlive(first, "/first"),
          keepAlive(second, "/second"),
        ]);
        expect(responses.map(statusOf)).toEqual([200, 200]);
        expect(upstream.requests.map((r) => [r.url, r.headers.host])).toEqual([
          ["/first", first],
          ["/second", second],
        ]);
      });
    });
  });

  describe("internal hosts: the runner rule, per port (#1819)", () => {
    /** The real SSRF floor, every name resolving to `address`, `internal.test` operator-listed. */
    const runnerListener = (uris: string[], address = privateIpv4()) =>
      makeListener({
        isBlockedHostFn: undefined,
        resolveHostFn: async () => [address],
        egressPolicy: compileRunnerEgressPolicy(
          { authorizedUris: uris, declaredUris: uris, allowAllUris: false },
          (h) => h === "internal.test",
        ),
      });
    /** CONNECT to `internal.test:<port>` through a listener over `uris`. */
    const connectInternal = async (uris: string[], port: number, address?: string) => {
      const { handle, events } = await runnerListener(uris, address);
      const res = await connectAndProbe(handle.address().port, `internal.test:${port}`, "ping");
      return { ...res, events };
    };

    it("relays to a private address behind a listed declared host:port", async () => {
      const echo = await startTcpEcho(privateIpv4());
      const res = await connectInternal([`tcp://internal.test:${echo.port}`], echo.port);
      expect(res.statusCode).toBe(200);
      expect(res.echoed).toBe("ping");
    });

    it("refuses a listed declared name that resolves to loopback", async () => {
      const echo = await startTcpEcho();
      const uris = [`http://internal.test:${echo.port}/**`];
      const res = await connectInternal(uris, echo.port, "127.0.0.1");
      expect(res.statusCode).toBe(403);
      expect(res.events.some((e) => e.reason === "ssrf")).toBe(true);
      expect(echo.received).toEqual([]);
    });

    it("keeps the floor on a port only another entry grants", async () => {
      // The allowlist lets `internal.test:<port>` through the glob; only :443 is declared with it.
      const echo = await startTcpEcho(privateIpv4());
      const uris = ["https://internal.test/**", `https://*.test:${echo.port}/**`];
      const res = await connectInternal(uris, echo.port);
      expect(res.statusCode).toBe(403);
      expect(res.events.some((e) => e.reason === "ssrf")).toBe(true);
    });

    it("judges each http:// request on a connection by its own port", async () => {
      const upstream = await startHttpUpstream(privateIpv4());
      const globbed = 9; // never dialed: the floor refuses it
      const uris = [`http://internal.test:${upstream.port}/**`, `http://*.test:${globbed}/**`];
      const { handle, events } = await runnerListener(uris);
      const request = (port: number) =>
        `GET http://internal.test:${port}/ HTTP/1.1\r\nHost: internal.test\r\n\r\n`;

      const responses = await keepAliveExchange(handle.address().port, [
        request(upstream.port),
        request(globbed),
      ]);
      expect(responses.map(statusOf)).toEqual([200, 403]);
      expect(upstream.requests).toHaveLength(1);
      expect(events).toContainEqual({
        kind: "tunnel-refused",
        target: `internal.test:${globbed}`,
        reason: "ssrf",
      });
    });
  });

  describe("first tunnel bytes (SNI vetting)", () => {
    const tlsListener = (echoPort: number, extra: Parameters<typeof makeListener>[0] = {}) =>
      makeListener({
        egressPolicy: {
          allowsAuthority: (h, p) => h === "allowed.example.com" && p === echoPort,
          skipsSsrfFloor: () => false,
        },
        resolveHostFn: async () => ["127.0.0.1"],
        ...extra,
      });
    /** CONNECT to the granted `allowed.example.com:<port>`, then write `segments`. */
    const throughAllowed = (proxyPort: number, port: number, segments: Buffer[]) =>
      tunnel(proxyPort, [connectTo(`allowed.example.com:${port}`)], segments);
    /** The CONNECT head and `first` in ONE write: the status, and what echoes past it by close. */
    const sameWrite = (proxyPort: number, port: number, first: Buffer) =>
      new Promise<{ statusCode: number; echoed: Buffer }>((resolve, reject) => {
        const connect = Buffer.from(connectTo(`allowed.example.com:${port}`));
        const socket = netConnect(proxyPort, "127.0.0.1", () =>
          socket.write(Buffer.concat([connect, first])),
        );
        let buf = Buffer.alloc(0);
        const finish = () => {
          clearTimeout(timer);
          socket.destroy();
          const end = buf.indexOf("\r\n\r\n");
          resolve({
            statusCode: parseInt(buf.toString("latin1").split(" ")[1] ?? "0"),
            echoed: end === -1 ? Buffer.alloc(0) : buf.subarray(end + 4),
          });
        };
        socket.on("data", (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          const end = buf.indexOf("\r\n\r\n");
          if (end !== -1 && buf.length - end - 4 >= first.length) finish();
        });
        socket.on("close", finish);
        socket.on("error", () => {}); // a reset surfaces as `close`
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error("tunnel timeout"));
        }, 5000);
      });

    it("splices a ClientHello whose SNI the policy grants, even split across segments", async () => {
      const echo = await startTcpEcho();
      const { handle, events } = await tlsListener(echo.port);
      const hello = buildClientHello("allowed.example.com");

      const res = await throughAllowed(handle.address().port, echo.port, [
        hello.subarray(0, 7),
        hello.subarray(7),
      ]);
      expect(res.statusCode).toBe(200);
      expect(res.echoed.equals(hello)).toBe(true);
      expect(events.some((e) => e.kind === "tunnel-opened")).toBe(true);
    });

    it("refuses another host's SNI through an allowed CONNECT target; upstream gets nothing", async () => {
      const echo = await startTcpEcho();
      const { handle, events } = await tlsListener(echo.port);

      const res = await throughAllowed(handle.address().port, echo.port, [
        buildClientHello("attacker-zone.example"),
      ]);
      await echo.closed;
      expect(res.statusCode).toBe(200);
      expect(res.echoed.length).toBe(0);
      expect(echo.received).toEqual([]);
      expect(events).toContainEqual({
        kind: "tunnel-refused",
        target: `attacker-zone.example:${echo.port}`,
        reason: "not-authorized",
      });
      expect(events.some((e) => e.kind === "tunnel-opened")).toBe(false);
    });

    it("vets a ClientHello sent in the same write as the CONNECT head", async () => {
      const echo = await startTcpEcho();
      const { handle } = await tlsListener(echo.port);
      const hello = buildClientHello("allowed.example.com");

      const res = await sameWrite(handle.address().port, echo.port, hello);
      await echo.closed;
      expect(res.statusCode).toBe(200);
      expect(res.echoed.equals(hello)).toBe(true);
      expect(Buffer.concat(echo.received).equals(hello)).toBe(true);
    });

    it("refuses another host's SNI sent with the CONNECT head; upstream gets nothing", async () => {
      const echo = await startTcpEcho();
      const { handle, events } = await tlsListener(echo.port);

      const res = await sameWrite(
        handle.address().port,
        echo.port,
        buildClientHello("attacker-zone.example"),
      );
      await echo.closed;
      expect(res.echoed.length).toBe(0);
      expect(echo.received).toEqual([]);
      expect(events.some((e) => e.reason === "not-authorized")).toBe(true);
      expect(events.some((e) => e.kind === "tunnel-opened")).toBe(false);
    });

    it("refuses a ClientHello fragmented across records (its SNI could hide later)", async () => {
      const echo = await startTcpEcho();
      const { handle, events } = await tlsListener(echo.port);
      const handshake = buildClientHello("attacker-zone.example").subarray(5);
      const firstRecord = tlsRecord(handshake.subarray(0, 20));

      await throughAllowed(handle.address().port, echo.port, [firstRecord]);
      await echo.closed;
      expect(echo.received).toEqual([]);
      expect(events.some((e) => e.reason === "malformed-client-hello")).toBe(true);
    });

    it("relays a ClientHello without SNI (the CONNECT target was already vetted)", async () => {
      const echo = await startTcpEcho();
      const { handle } = await tlsListener(echo.port);
      const hello = buildClientHello(null);

      const res = await throughAllowed(handle.address().port, echo.port, [hello]);
      expect(res.statusCode).toBe(200);
      expect(res.echoed.equals(hello)).toBe(true);
    });

    it("closes a tunnel silent on both sides after the 200, with a preamble-timeout event", async () => {
      const echo = await startTcpEcho();
      const { handle, events } = await tlsListener(echo.port, { preambleTimeoutMs: 100 });

      const target = `allowed.example.com:${echo.port}`;
      const res = await tunnel(handle.address().port, [connectTo(target)], []);
      await echo.closed;
      expect(res.statusCode).toBe(200);
      expect(echo.received).toEqual([]);
      expect(events).toContainEqual({ kind: "tunnel-refused", target, reason: "preamble-timeout" });
      expect(events.some((e) => e.kind === "tunnel-opened")).toBe(false);
    });

    it("relays a server-first banner before the client speaks, past the preamble deadline", async () => {
      const banner = "220 smtp.example ESMTP\r\n";
      const upstream = await startBannerServer(banner);
      const { handle, events } = await tlsListener(upstream.port, { preambleTimeoutMs: 100 });
      const target = `allowed.example.com:${upstream.port}`;

      const seen = await new Promise<string>((resolve, reject) => {
        const socket = netConnect(handle.address().port, "127.0.0.1", () => {
          socket.write(connectTo(target));
        });
        let buf = "";
        socket.on("data", (chunk: Buffer) => {
          buf += chunk.toString("latin1");
          const body = buf.split("\r\n\r\n").slice(1).join("\r\n\r\n");
          if (body !== banner) return;
          // Reply well after the preamble deadline: the banner must have disarmed it.
          setTimeout(() => socket.write("EHLO runner\r\n"), 300);
          void upstream.gotData.then(() => {
            socket.destroy();
            resolve(body);
          });
        });
        socket.on("error", reject);
        setTimeout(() => reject(new Error("banner timeout")), 5000);
      });

      expect(seen).toBe(banner);
      expect(upstream.received()).toBe("EHLO runner\r\n");
      expect(events.some((e) => e.kind === "tunnel-opened")).toBe(true);
      expect(events.some((e) => e.reason === "preamble-timeout")).toBe(false);
    });
  });
});
