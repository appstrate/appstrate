// SPDX-License-Identifier: Apache-2.0

/**
 * Plain CONNECT egress listener (#543).
 *
 * Proves the no-injection egress path: a CONNECT tunnel to an allowed host
 * relays raw bytes (NO TLS termination, NO cert mint), the SSRF floor refuses
 * internal / cloud-metadata targets, non-CONNECT verbs are rejected, and the
 * hard allowlist (#1458) gates by peer, by `host:port` and by the SNI a TLS
 * tunnel carries.
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

/**
 * A raw TCP echo server — stands in for an upstream the runner tunnels to.
 * Records every byte it receives; `closed` settles when a connection ends.
 */
function startTcpEcho(): Promise<{ port: number; received: Buffer[]; closed: Promise<void> }> {
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
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ port: typeof addr === "object" && addr ? addr.port : 0, received, closed });
    });
  });
}

const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);

/** A minimal ClientHello record, with a `server_name` extension when `sni` is given. */
function clientHello(sni?: string): Buffer {
  let extensions = Buffer.alloc(0);
  if (sni) {
    const host = Buffer.from(sni);
    const entry = Buffer.concat([Buffer.from([0x00]), u16(host.length), host]);
    const list = Buffer.concat([u16(entry.length), entry]);
    extensions = Buffer.concat([u16(0x0000), u16(list.length), list]);
  }
  const body = Buffer.concat([
    u16(0x0303),
    Buffer.alloc(32, 7),
    Buffer.from([0]),
    Buffer.concat([u16(2), u16(0x1301)]),
    Buffer.from([1, 0]),
    u16(extensions.length),
    extensions,
  ]);
  const handshake = Buffer.concat([Buffer.from([0x01, 0]), u16(body.length), body]);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(handshake.length), handshake]);
}

/**
 * CONNECT to `target`, then write `segments` (20 ms apart) once the 200 lands.
 * Resolves when every written byte has echoed back or the tunnel closes.
 */
function tunnelThrough(
  proxyPort: number,
  target: string,
  segments: Buffer[],
): Promise<{ statusCode: number; echoed: Buffer }> {
  const expected = segments.reduce((n, seg) => n + seg.length, 0);
  return new Promise((resolve, reject) => {
    const socket = netConnect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let head = "";
    let statusCode = 0;
    const echoed: Buffer[] = [];
    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ statusCode, echoed: Buffer.concat(echoed) });
    };
    socket.on("data", (chunk: Buffer) => {
      if (statusCode === 0) {
        head += chunk.toString("latin1");
        if (!head.includes("\r\n\r\n")) return;
        statusCode = parseInt(head.split(" ")[1] ?? "0");
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
    egressPolicy: { allowsAuthority: () => true },
    isPeerAllowed: async () => true,
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

  it("refuses a host the egress policy does not grant, before resolving it", async () => {
    const echo = await startTcpEcho();
    let resolved = false;
    const { handle, events } = await makeListener({
      egressPolicy: { allowsAuthority: (h) => h === "allowed.example.com" },
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

  it("tunnels a host:port the egress policy grants", async () => {
    const echo = await startTcpEcho();
    const { handle } = await makeListener({
      egressPolicy: { allowsAuthority: (h, p) => h === "allowed.example.com" && p === echo.port },
      resolveHostFn: async () => ["127.0.0.1"],
    });
    const res = await connectAndProbe(
      handle.address().port,
      `allowed.example.com:${echo.port}`,
      "ping",
    );
    expect(res.statusCode).toBe(200);
    expect(res.echoed).toBe("ping");
  });

  it("refuses a peer that is not the owning runner, before parsing its CONNECT", async () => {
    const echo = await startTcpEcho();
    const peers: string[] = [];
    let policyConsulted = false;
    const { handle, events } = await makeListener({
      isPeerAllowed: async (ip) => {
        peers.push(ip);
        return false;
      },
      egressPolicy: {
        allowsAuthority: () => {
          policyConsulted = true;
          return true;
        },
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

  describe("first tunnel bytes (SNI vetting)", () => {
    const tlsListener = (echoPort: number, extra: Parameters<typeof makeListener>[0] = {}) =>
      makeListener({
        egressPolicy: {
          allowsAuthority: (h, p) => h === "allowed.example.com" && p === echoPort,
        },
        resolveHostFn: async () => ["127.0.0.1"],
        ...extra,
      });

    it("splices a ClientHello whose SNI the policy grants, even split across segments", async () => {
      const echo = await startTcpEcho();
      const { handle, events } = await tlsListener(echo.port);
      const hello = clientHello("allowed.example.com");

      const res = await tunnelThrough(handle.address().port, `allowed.example.com:${echo.port}`, [
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

      const res = await tunnelThrough(handle.address().port, `allowed.example.com:${echo.port}`, [
        clientHello("attacker-zone.example"),
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

    it("refuses a ClientHello fragmented across records (its SNI could hide later)", async () => {
      const echo = await startTcpEcho();
      const { handle, events } = await tlsListener(echo.port);
      const handshake = clientHello("attacker-zone.example").subarray(5);
      const firstRecord = Buffer.concat([
        Buffer.from([0x16, 0x03, 0x01]),
        u16(20),
        handshake.subarray(0, 20),
      ]);

      await tunnelThrough(handle.address().port, `allowed.example.com:${echo.port}`, [firstRecord]);
      await echo.closed;
      expect(echo.received).toEqual([]);
      expect(events.some((e) => e.reason === "malformed-client-hello")).toBe(true);
    });

    it("relays a ClientHello without SNI (the CONNECT target was already vetted)", async () => {
      const echo = await startTcpEcho();
      const { handle } = await tlsListener(echo.port);
      const hello = clientHello();

      const target = `allowed.example.com:${echo.port}`;
      const res = await tunnelThrough(handle.address().port, target, [hello]);
      expect(res.statusCode).toBe(200);
      expect(res.echoed.equals(hello)).toBe(true);
    });

    it("relays a non-TLS stream (SSH banner exchange) as before", async () => {
      const echo = await startTcpEcho();
      const { handle } = await tlsListener(echo.port);
      const banner = Buffer.from("SSH-2.0-OpenSSH_9.6\r\n");

      const res = await tunnelThrough(handle.address().port, `allowed.example.com:${echo.port}`, [
        banner,
        Buffer.from("key-exchange"),
      ]);
      expect(res.statusCode).toBe(200);
      expect(res.echoed.toString()).toBe("SSH-2.0-OpenSSH_9.6\r\nkey-exchange");
    });

    it("closes a tunnel whose client stays silent after the 200", async () => {
      const echo = await startTcpEcho();
      const { handle, events } = await tlsListener(echo.port, { preambleTimeoutMs: 100 });

      const target = `allowed.example.com:${echo.port}`;
      const res = await tunnelThrough(handle.address().port, target, []);
      await echo.closed;
      expect(res.statusCode).toBe(200);
      expect(echo.received).toEqual([]);
      expect(events.some((e) => e.kind === "tunnel-opened")).toBe(false);
    });
  });
});
