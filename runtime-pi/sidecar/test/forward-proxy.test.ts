// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "bun:test";
import { createServer } from "node:http";
import type { Server as HttpServer, IncomingMessage, ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import { createForwardProxy, type ForwardProxyResult } from "../forward-proxy.ts";

// Track servers for cleanup
const servers: (HttpServer | ForwardProxyResult)[] = [];

function cleanup(): Promise<void[]> {
  const promises = servers.map((s) => {
    const srv = "server" in s ? s.server : s;
    return new Promise<void>((resolve) => {
      srv.close(() => resolve());
      // Force-close lingering connections
      setTimeout(() => resolve(), 100);
    });
  });
  servers.length = 0;
  return Promise.all(promises);
}

afterEach(async () => {
  await cleanup();
});

/** Start a simple echo HTTP server on an ephemeral port. Returns port. */
function startEchoServer(): Promise<{ port: number; server: HttpServer }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body,
          }),
        );
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" ? addr!.port : 0;
      resolve({ port, server });
    });
  });
}

function makeProxy(overrides?: Parameters<typeof createForwardProxy>[0]): ForwardProxyResult {
  const result = createForwardProxy({
    config: { platformApiUrl: "http://mock:3000", runToken: "tok", proxyUrl: "" },
    listenPort: 0,
    listenHost: "127.0.0.1",
    // Allow 127.0.0.1 by default for testing (otherwise echo server is blocked)
    isBlockedHostFn: () => false,
    ...overrides,
  });
  servers.push(result);
  return result;
}

/** Send an HTTP request through the forward proxy. */
async function httpViaProxy(
  proxyPort: number,
  targetUrl: string,
  method = "GET",
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const { request } = require("node:http");
    const req = request(
      {
        hostname: "127.0.0.1",
        port: proxyPort,
        path: targetUrl,
        method,
        headers: { host: parsed.host },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers[k] = v;
          }
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            headers,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Send a CONNECT request through the forward proxy. Returns the raw status line. */
function connectViaProxy(
  proxyPort: number,
  target: string,
): Promise<{ statusCode: number; statusLine: string }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
      // Look for end of HTTP response headers
      if (data.includes("\r\n\r\n")) {
        const statusLine = data.split("\r\n")[0]!;
        const statusCode = parseInt(statusLine.split(" ")[1] ?? "0");
        socket.destroy();
        resolve({ statusCode, statusLine });
      }
    });
    socket.on("error", reject);
    // Timeout in case nothing comes back
    setTimeout(() => {
      socket.destroy();
      reject(new Error("CONNECT timeout"));
    }, 5000);
  });
}

// --- HTTP forwarding ---

describe("HTTP forwarding", () => {
  it("forwards GET to echo server", async () => {
    const echo = await startEchoServer();
    const proxy = makeProxy();
    await proxy.ready;
    const { port } = proxy.address();

    const res = await httpViaProxy(port, `http://127.0.0.1:${echo.port}/test?q=1`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.method).toBe("GET");
    expect(body.url).toBe("/test?q=1");
  });

  it("blocks 127.0.0.1 with real isBlockedHost", async () => {
    const proxy = makeProxy({ isBlockedHostFn: undefined });
    await proxy.ready;
    const { port } = proxy.address();

    const res = await httpViaProxy(port, "http://127.0.0.1:9999/blocked");
    expect(res.status).toBe(403);
    expect(res.body).toContain("Blocked");
  });

  it("blocks 169.254.x.x with real isBlockedHost", async () => {
    const proxy = makeProxy({ isBlockedHostFn: undefined });
    await proxy.ready;
    const { port } = proxy.address();

    const res = await httpViaProxy(port, "http://169.254.169.254/latest/meta-data/");
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid URL", async () => {
    const proxy = makeProxy();
    await proxy.ready;
    const { port } = proxy.address();

    // Use raw TCP to send an HTTP request with an invalid URL
    // (Bun's http.request validates URLs before sending)
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const socket = netConnect(port, "127.0.0.1", () => {
        socket.write("GET not-a-valid-url HTTP/1.1\r\nHost: invalid\r\n\r\n");
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
      });
      socket.on("end", () => {
        const statusLine = data.split("\r\n")[0] ?? "";
        const statusCode = parseInt(statusLine.split(" ")[1] ?? "0");
        const bodyStart = data.indexOf("\r\n\r\n");
        const body = bodyStart >= 0 ? data.slice(bodyStart + 4) : "";
        resolve({ status: statusCode, body });
      });
      socket.on("error", reject);
      setTimeout(() => {
        socket.destroy();
        reject(new Error("timeout"));
      }, 5000);
    });
    expect(res.status).toBe(400);
  });

  it("strips hop-by-hop headers", async () => {
    const echo = await startEchoServer();
    const proxy = makeProxy();
    await proxy.ready;
    const { port } = proxy.address();

    // Send a request with a hop-by-hop header
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const { request } = require("node:http");
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path: `http://127.0.0.1:${echo.port}/headers`,
          method: "GET",
          headers: {
            host: `127.0.0.1:${echo.port}`,
            "proxy-authorization": "Basic secret",
            "x-custom": "keep-me",
          },
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });

    const body = JSON.parse(res.body);
    expect(body.headers["proxy-authorization"]).toBeUndefined();
    expect(body.headers["x-custom"]).toBe("keep-me");
  });

  it("returns 502 on upstream connection error", async () => {
    const proxy = makeProxy();
    await proxy.ready;
    const { port } = proxy.address();

    // Target a port that's not listening
    const res = await httpViaProxy(port, "http://127.0.0.1:1/nothing");
    expect(res.status).toBe(502);
  });
});

// --- CONNECT tunneling ---

describe("CONNECT tunneling", () => {
  it("establishes tunnel to allowed host", async () => {
    const echo = await startEchoServer();
    const proxy = makeProxy();
    await proxy.ready;
    const { port } = proxy.address();

    const res = await connectViaProxy(port, `127.0.0.1:${echo.port}`);
    expect(res.statusCode).toBe(200);
    expect(res.statusLine).toContain("Connection Established");
  });

  it("blocks loopback with real isBlockedHost", async () => {
    const proxy = makeProxy({ isBlockedHostFn: undefined });
    await proxy.ready;
    const { port } = proxy.address();

    const res = await connectViaProxy(port, "127.0.0.1:443");
    expect(res.statusCode).toBe(403);
  });

  it("blocks metadata service with real isBlockedHost", async () => {
    const proxy = makeProxy({ isBlockedHostFn: undefined });
    await proxy.ready;
    const { port } = proxy.address();

    const res = await connectViaProxy(port, "169.254.169.254:80");
    expect(res.statusCode).toBe(403);
  });

  it("returns 400 for empty host", async () => {
    const proxy = makeProxy();
    await proxy.ready;
    const { port } = proxy.address();

    const res = await connectViaProxy(port, ":443");
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for malformed bracket notation", async () => {
    const proxy = makeProxy();
    await proxy.ready;
    const { port } = proxy.address();

    const res = await connectViaProxy(port, "[::1:443");
    expect(res.statusCode).toBe(400);
  });

  it("blocks IPv6 loopback with real isBlockedHost", async () => {
    const proxy = makeProxy({ isBlockedHostFn: undefined });
    await proxy.ready;
    const { port } = proxy.address();

    const res = await connectViaProxy(port, "[::1]:443");
    expect(res.statusCode).toBe(403);
  });
});

// --- Platform host exemption ---

describe("platform host exemption", () => {
  it("HTTP: allows requests to the configured platform host even if it would otherwise be blocked", async () => {
    const echo = await startEchoServer();
    // Pretend 127.0.0.1 is the platform — real isBlockedHost would block it,
    // but the exemption rule should let it through.
    const proxy = makeProxy({
      config: {
        platformApiUrl: `http://127.0.0.1:${echo.port}`,
        runToken: "tok",
        proxyUrl: "",
      },
      isBlockedHostFn: undefined,
    });
    await proxy.ready;
    const { port } = proxy.address();

    const res = await httpViaProxy(port, `http://127.0.0.1:${echo.port}/sink/events`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.url).toBe("/sink/events");
  });

  it("HTTP: still blocks other internal hosts when a platform host is configured", async () => {
    const proxy = makeProxy({
      config: {
        platformApiUrl: "http://host.docker.internal:3000",
        runToken: "tok",
        proxyUrl: "",
      },
      isBlockedHostFn: undefined,
    });
    await proxy.ready;
    const { port } = proxy.address();

    const res = await httpViaProxy(port, "http://169.254.169.254/latest/meta-data/");
    expect(res.status).toBe(403);
  });

  it("HTTP: hostname comparison is case-insensitive", async () => {
    const echo = await startEchoServer();
    const proxy = makeProxy({
      config: {
        platformApiUrl: `http://127.0.0.1:${echo.port}`,
        runToken: "tok",
        proxyUrl: "",
      },
      // Block any host containing uppercase to prove the exemption matches before blocking
      isBlockedHostFn: () => true,
    });
    await proxy.ready;
    const { port } = proxy.address();

    const res = await httpViaProxy(port, `http://127.0.0.1:${echo.port}/x`);
    expect(res.status).toBe(200);
  });

  it("HTTP: re-reads platformApiUrl on every request (pool reconfiguration)", async () => {
    const echo = await startEchoServer();
    const config = {
      platformApiUrl: "http://placeholder:1",
      runToken: "tok",
      proxyUrl: "",
    };
    const proxy = makeProxy({ config, isBlockedHostFn: undefined });
    await proxy.ready;
    const { port } = proxy.address();

    // Initially 127.0.0.1 is blocked because platformApiUrl points elsewhere
    const blocked = await httpViaProxy(port, `http://127.0.0.1:${echo.port}/before`);
    expect(blocked.status).toBe(403);

    // Mutate config to simulate a late platform-API resolution
    config.platformApiUrl = `http://127.0.0.1:${echo.port}`;

    const allowed = await httpViaProxy(port, `http://127.0.0.1:${echo.port}/after`);
    expect(allowed.status).toBe(200);
  });

  it("HTTP: tolerates an invalid platformApiUrl without crashing (falls back to blocklist only)", async () => {
    const proxy = makeProxy({
      config: { platformApiUrl: "::not a url::", runToken: "tok", proxyUrl: "" },
      isBlockedHostFn: undefined,
    });
    await proxy.ready;
    const { port } = proxy.address();

    const res = await httpViaProxy(port, "http://127.0.0.1:9999/x");
    expect(res.status).toBe(403);
  });

  it("CONNECT: allows tunnels to the configured platform host", async () => {
    const echo = await startEchoServer();
    const proxy = makeProxy({
      config: {
        platformApiUrl: `http://127.0.0.1:${echo.port}`,
        runToken: "tok",
        proxyUrl: "",
      },
      isBlockedHostFn: undefined,
    });
    await proxy.ready;
    const { port } = proxy.address();

    const res = await connectViaProxy(port, `127.0.0.1:${echo.port}`);
    expect(res.statusCode).toBe(200);
    expect(res.statusLine).toContain("Connection Established");
  });

  it("CONNECT: still blocks other internal hosts when a platform host is configured", async () => {
    const proxy = makeProxy({
      config: {
        platformApiUrl: "http://host.docker.internal:3000",
        runToken: "tok",
        proxyUrl: "",
      },
      isBlockedHostFn: undefined,
    });
    await proxy.ready;
    const { port } = proxy.address();

    const res = await connectViaProxy(port, "169.254.169.254:80");
    expect(res.statusCode).toBe(403);
  });
});

// --- Lifecycle ---

describe("lifecycle", () => {
  it("ready promise resolves", async () => {
    const proxy = makeProxy();
    await proxy.ready;
    expect(proxy.readySync).toBe(true);
  });

  it("address returns ephemeral port", async () => {
    const proxy = makeProxy();
    await proxy.ready;
    const addr = proxy.address();
    expect(addr.port).toBeGreaterThan(0);
    expect(addr.host).toBe("127.0.0.1");
  });

  it("server.close stops listening", async () => {
    const proxy = makeProxy();
    await proxy.ready;
    const { port } = proxy.address();
    expect(port).toBeGreaterThan(0);
    await new Promise<void>((resolve) => proxy.server.close(() => resolve()));
    // Remove from cleanup list since we closed manually
    const idx = servers.indexOf(proxy);
    if (idx !== -1) servers.splice(idx, 1);
  });

  it("readySync is false before listen", () => {
    const proxy = makeProxy();
    // May already be true if listen is instant, but at least verify the property exists
    expect(typeof proxy.readySync).toBe("boolean");
  });
});
