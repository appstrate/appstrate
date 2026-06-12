// SPDX-License-Identifier: Apache-2.0

/**
 * Plain CONNECT egress listener (#543).
 *
 * Proves the no-injection egress path: a CONNECT tunnel to an allowed host
 * relays raw bytes (NO TLS termination, NO cert mint), the SSRF floor refuses
 * internal / cloud-metadata targets, non-CONNECT verbs are rejected, and the
 * optional hard allowlist (follow-up seam) gates by host when supplied.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { createServer as netCreateServer, connect as netConnect } from "node:net";
import type { Server as NetServer } from "node:net";

import {
  createIntegrationEgressListener,
  type EgressListenerEvent,
} from "../integration-egress-listener.ts";
import type { MitmListenerHandle } from "../integration-mitm-listener.ts";

const listeners: MitmListenerHandle[] = [];
const tcpServers: NetServer[] = [];

afterEach(async () => {
  await Promise.all(listeners.map((l) => l.close().catch(() => {})));
  listeners.length = 0;
  await Promise.all(tcpServers.map((s) => new Promise<void>((res) => s.close(() => res()))));
  tcpServers.length = 0;
});

/** A raw TCP echo server — stands in for an upstream the runner tunnels to. */
function startTcpEcho(): Promise<{ port: number }> {
  return new Promise((resolve) => {
    const server = netCreateServer((socket) => {
      socket.on("data", (chunk) => socket.write(chunk));
      socket.on("error", () => socket.destroy());
    });
    tcpServers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

function makeListener(
  overrides: Parameters<typeof createIntegrationEgressListener>[0] = {},
): Promise<{ handle: MitmListenerHandle; events: EgressListenerEvent[] }> {
  const events: EgressListenerEvent[] = [];
  const handle = createIntegrationEgressListener({
    host: "127.0.0.1",
    // Allow loopback by default so the echo server is reachable in tests.
    isBlockedHostFn: () => false,
    onEvent: (e) => events.push(e),
    ...overrides,
  });
  listeners.push(handle);
  return handle.ready.then(() => ({ handle, events }));
}

/**
 * Open a CONNECT tunnel through the listener. Resolves with the status line
 * and, if the tunnel established, the echo round-trip of `probe`.
 */
function connectAndProbe(
  proxyPort: number,
  target: string,
  probe?: string,
): Promise<{ statusCode: number; echoed?: string }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let phase: "header" | "tunnel" = "header";
    let buf = "";
    let echoed = "";
    let statusCode = 0;
    socket.on("data", (chunk) => {
      if (phase === "header") {
        buf += chunk.toString("latin1");
        const end = buf.indexOf("\r\n\r\n");
        if (end === -1) return;
        statusCode = parseInt(buf.split(" ")[1] ?? "0");
        if (statusCode !== 200 || !probe) {
          socket.destroy();
          resolve({ statusCode });
          return;
        }
        phase = "tunnel";
        socket.write(probe);
      } else {
        echoed += chunk.toString();
        if (echoed.length >= (probe?.length ?? 0)) {
          socket.destroy();
          resolve({ statusCode, echoed });
        }
      }
    });
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      reject(new Error("CONNECT timeout"));
    }, 5000);
  });
}

describe("integration-egress-listener (#543)", () => {
  it("relays a CONNECT tunnel to an allowed host (no TLS termination)", async () => {
    const echo = await startTcpEcho();
    const { handle, events } = await makeListener();
    const port = handle.address().port;

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

  it("rejects non-CONNECT verbs with 405", async () => {
    const { handle } = await makeListener();
    const port = handle.address().port;
    const statusCode = await new Promise<number>((resolve, reject) => {
      const socket = netConnect(port, "127.0.0.1", () => {
        socket.write("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n");
      });
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString();
        if (buf.includes("\r\n\r\n")) {
          socket.destroy();
          resolve(parseInt(buf.split(" ")[1] ?? "0"));
        }
      });
      socket.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });
    expect(statusCode).toBe(405);
  });

  it("relays when the CONNECT request line is split across TCP segments", async () => {
    const echo = await startTcpEcho();
    const { handle, events } = await makeListener();
    const port = handle.address().port;
    const target = `127.0.0.1:${echo.port}`;

    const res = await new Promise<{ statusCode: number; echoed: string }>((resolve, reject) => {
      const socket = netConnect(port, "127.0.0.1", () => {
        // Fragment the request line itself across two writes — the verb lands
        // in one segment, the rest (incl. the CRLF) in the next.
        socket.write("CONN");
        setTimeout(() => socket.write(`ECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`), 20);
      });
      let phase: "header" | "tunnel" = "header";
      let buf = "";
      let echoed = "";
      let statusCode = 0;
      socket.on("data", (chunk) => {
        if (phase === "header") {
          buf += chunk.toString("latin1");
          const end = buf.indexOf("\r\n\r\n");
          if (end === -1) return;
          statusCode = parseInt(buf.split(" ")[1] ?? "0");
          if (statusCode !== 200) {
            socket.destroy();
            resolve({ statusCode, echoed });
            return;
          }
          phase = "tunnel";
          socket.write("ping");
        } else {
          echoed += chunk.toString();
          if (echoed.length >= 4) {
            socket.destroy();
            resolve({ statusCode, echoed });
          }
        }
      });
      socket.on("error", reject);
      setTimeout(() => reject(new Error("CONNECT timeout")), 5000);
    });

    expect(res.statusCode).toBe(200);
    expect(res.echoed).toBe("ping");
    expect(events.some((e) => e.kind === "tunnel-opened")).toBe(true);
  });

  it("enforces the optional hard allowlist when supplied", async () => {
    const echo = await startTcpEcho();
    const { handle, events } = await makeListener({
      authorizedHostMatcher: (h) => h === "allowed.example.com",
    });
    const port = handle.address().port;

    // 127.0.0.1 passes the (stubbed) SSRF floor but fails the allowlist.
    const res = await connectAndProbe(port, `127.0.0.1:${echo.port}`);
    expect(res.statusCode).toBe(403);
    expect(events.some((e) => e.kind === "tunnel-refused" && e.reason === "not-authorized")).toBe(
      true,
    );
  });
});
