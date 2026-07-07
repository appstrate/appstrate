// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the transparent SNI-passthrough egress listener (#779).
 *
 * Real TCP servers/sockets on 127.0.0.1, injected SSRF/DNS stubs — same
 * harness style as integration-egress-listener.test.ts. TLS ClientHellos
 * are hand-built buffers (the listener never terminates TLS, so a plain
 * echo upstream suffices to assert byte-exact preamble replay + splice).
 */

import { describe, it, expect, afterEach } from "bun:test";
import { createServer, connect as netConnect } from "node:net";
import type { Server, Socket } from "node:net";

import {
  createTransparentEgressListener,
  type TransparentListenerHandle,
} from "../integration-transparent-listener.ts";
import type { EgressListenerEvent } from "../integration-egress-listener.ts";

const openListeners: TransparentListenerHandle[] = [];
const openServers: Server[] = [];

afterEach(async () => {
  for (const l of openListeners.splice(0)) {
    await l.close().catch(() => {});
  }
  for (const s of openServers.splice(0)) {
    await new Promise<void>((res) => s.close(() => res()));
  }
});

/** Plain TCP echo upstream — records everything it receives. */
async function startTcpEcho(): Promise<{ port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  const server = createServer((socket) => {
    socket.on("data", (chunk: Buffer) => {
      received.push(chunk);
      socket.write(chunk);
    });
  });
  openServers.push(server);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  return { port, received };
}

async function makeListener(
  opts: {
    upstreamPort?: number;
    onEvent?: (e: EgressListenerEvent) => void;
    isBlockedHostFn?: (host: string) => boolean;
    resolveHostFn?: (host: string) => Promise<string[]>;
    authorizedHostMatcher?: (host: string) => boolean;
  } = {},
): Promise<TransparentListenerHandle> {
  const listener = createTransparentEgressListener({
    host: "127.0.0.1",
    port: 0,
    isBlockedHostFn: opts.isBlockedHostFn ?? (() => false),
    resolveHostFn: opts.resolveHostFn ?? (async () => ["127.0.0.1"]),
    ...(opts.upstreamPort !== undefined ? { upstreamPort: opts.upstreamPort } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    ...(opts.authorizedHostMatcher ? { authorizedHostMatcher: opts.authorizedHostMatcher } : {}),
  });
  openListeners.push(listener);
  await listener.ready;
  return listener;
}

/**
 * Hand-build a minimal TLS 1.2/1.3-shaped ClientHello record carrying the
 * given SNI (RFC 8446 §4.1.2 + RFC 6066 §3). Pass `sni: null` for a hello
 * without the server_name extension.
 */
function buildClientHello(sni: string | null): Buffer {
  const extensions: Buffer[] = [];
  if (sni !== null) {
    const host = Buffer.from(sni, "utf-8");
    const serverName = Buffer.alloc(5);
    serverName.writeUInt16BE(host.length + 3, 0); // server_name_list length
    serverName.writeUInt8(0, 2); // name_type host_name
    serverName.writeUInt16BE(host.length, 3);
    const extData = Buffer.concat([serverName, host]);
    const extHeader = Buffer.alloc(4);
    extHeader.writeUInt16BE(0x0000, 0); // extension_type server_name
    extHeader.writeUInt16BE(extData.length, 2);
    extensions.push(Buffer.concat([extHeader, extData]));
  }
  const extBlock = Buffer.concat(extensions);
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]), // legacy_version
    Buffer.alloc(32), // random
    Buffer.from([0x00]), // session_id length
    Buffer.from([0x00, 0x02, 0x13, 0x01]), // one cipher suite
    Buffer.from([0x01, 0x00]), // one compression method (null)
    (() => {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(extBlock.length, 0);
      return b;
    })(),
    extBlock,
  ]);
  const handshake = Buffer.concat([
    Buffer.from([0x01, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]),
    body,
  ]);
  const record = Buffer.alloc(5);
  record.writeUInt8(0x16, 0);
  record.writeUInt16BE(0x0301, 1);
  record.writeUInt16BE(handshake.length, 3);
  return Buffer.concat([record, handshake]);
}

/** Connect, write chunks, collect echoed bytes until `expected` total or close. */
async function driveClient(
  port: number,
  chunks: Buffer[],
  expectedBytes: number,
  interChunkDelayMs = 0,
): Promise<{ received: Buffer; closed: boolean }> {
  return new Promise((resolve) => {
    const collected: Buffer[] = [];
    let done = false;
    const socket: Socket = netConnect(port, "127.0.0.1", () => {
      void (async () => {
        for (const chunk of chunks) {
          socket.write(chunk);
          if (interChunkDelayMs > 0) {
            await new Promise((r) => setTimeout(r, interChunkDelayMs));
          }
        }
      })();
    });
    const finish = (closed: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ received: Buffer.concat(collected), closed });
    };
    socket.on("data", (chunk: Buffer) => {
      collected.push(chunk);
      if (Buffer.concat(collected).length >= expectedBytes) finish(false);
    });
    socket.on("close", () => finish(true));
    socket.on("error", () => finish(true));
    setTimeout(() => finish(true), 3_000);
  });
}

describe("transparent egress listener — TLS SNI path", () => {
  it("splices a ClientHello to the upstream byte-exact and relays both ways", async () => {
    const upstream = await startTcpEcho();
    const events: EgressListenerEvent[] = [];
    const listener = await makeListener({
      upstreamPort: upstream.port,
      onEvent: (e) => events.push(e),
    });
    const hello = buildClientHello("api.test.local");
    const { received } = await driveClient(listener.address().port, [hello], hello.length);
    // Echo upstream: what we get back is exactly what upstream received —
    // the preamble must be replayed unmodified (no TLS termination).
    expect(received.equals(hello)).toBe(true);
    expect(Buffer.concat(upstream.received).equals(hello)).toBe(true);
    expect(events).toEqual([{ kind: "tunnel-opened", target: `api.test.local:${upstream.port}` }]);
  });

  it("keeps relaying after the preamble (bidirectional splice)", async () => {
    const upstream = await startTcpEcho();
    const listener = await makeListener({ upstreamPort: upstream.port });
    const hello = buildClientHello("api.test.local");
    const extra = Buffer.from("post-handshake bytes");
    const { received } = await driveClient(
      listener.address().port,
      [hello, extra],
      hello.length + extra.length,
      50,
    );
    expect(received.equals(Buffer.concat([hello, extra]))).toBe(true);
  });

  it("buffers bytes sent during the SSRF/dial window (pause before splice)", async () => {
    const upstream = await startTcpEcho();
    // Slow resolver widens the preamble→splice window; the extra chunk
    // lands inside it and must be buffered by pause(), not dropped.
    const listener = await makeListener({
      upstreamPort: upstream.port,
      resolveHostFn: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return ["127.0.0.1"];
      },
    });
    const hello = buildClientHello("api.test.local");
    const extra = Buffer.from("bytes-inside-the-window");
    const { received } = await driveClient(
      listener.address().port,
      [hello, extra],
      hello.length + extra.length,
      20, // second write fires while the resolver is still sleeping
    );
    expect(received.equals(Buffer.concat([hello, extra]))).toBe(true);
  });

  it("handles a ClientHello split across TCP segments", async () => {
    const upstream = await startTcpEcho();
    const listener = await makeListener({ upstreamPort: upstream.port });
    const hello = buildClientHello("split.test.local");
    const cut = 20; // mid-record
    const { received } = await driveClient(
      listener.address().port,
      [hello.subarray(0, cut), hello.subarray(cut)],
      hello.length,
      50,
    );
    expect(received.equals(hello)).toBe(true);
  });

  it("refuses an SSRF-blocked SNI host (socket destroyed, no upstream dial)", async () => {
    const upstream = await startTcpEcho();
    const events: EgressListenerEvent[] = [];
    const listener = await makeListener({
      upstreamPort: upstream.port,
      isBlockedHostFn: () => true,
      onEvent: (e) => events.push(e),
    });
    const hello = buildClientHello("169.254.169.254.nip.io");
    const { received, closed } = await driveClient(listener.address().port, [hello], 1);
    expect(closed).toBe(true);
    expect(received.length).toBe(0);
    expect(upstream.received.length).toBe(0);
    expect(events[0]?.kind).toBe("tunnel-refused");
    expect(events[0]?.reason).toBe("ssrf");
  });

  it("fails closed when DNS resolution fails", async () => {
    const events: EgressListenerEvent[] = [];
    const listener = await makeListener({
      resolveHostFn: async () => {
        throw new Error("resolution boom");
      },
      onEvent: (e) => events.push(e),
    });
    const { closed } = await driveClient(
      listener.address().port,
      [buildClientHello("api.test.local")],
      1,
    );
    expect(closed).toBe(true);
    expect(events[0]?.kind).toBe("tunnel-refused");
    expect(events[0]?.reason).toBe("dns-resolution-failed");
  });

  it("refuses a host outside the authorized matcher", async () => {
    const events: EgressListenerEvent[] = [];
    const listener = await makeListener({
      authorizedHostMatcher: (host) => host === "allowed.test.local",
      onEvent: (e) => events.push(e),
    });
    const { closed } = await driveClient(
      listener.address().port,
      [buildClientHello("denied.test.local")],
      1,
    );
    expect(closed).toBe(true);
    expect(events[0]?.reason).toBe("not-authorized");
  });

  it("destroys a complete ClientHello that carries no SNI when the client gives up", async () => {
    const events: EgressListenerEvent[] = [];
    const listener = await makeListener({ onEvent: (e) => events.push(e) });
    await new Promise<void>((resolve) => {
      const socket = netConnect(listener.address().port, "127.0.0.1", () => {
        socket.write(buildClientHello(null));
        // No SNI will ever parse — client hangs up; listener must not crash.
        setTimeout(() => socket.end(), 100);
      });
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
    });
    // Listener still alive and routable afterwards.
    const upstream = await startTcpEcho();
    const listener2 = await makeListener({ upstreamPort: upstream.port });
    const hello = buildClientHello("still.alive.local");
    const { received } = await driveClient(listener2.address().port, [hello], hello.length);
    expect(received.equals(hello)).toBe(true);
  });

  it("emits tunnel-error when the upstream connection fails", async () => {
    // Grab a port that refuses connections: bind + close a server.
    const probe = createServer();
    await new Promise<void>((res) => probe.listen(0, "127.0.0.1", () => res()));
    const addr = probe.address();
    const deadPort = addr && typeof addr === "object" ? addr.port : 1;
    await new Promise<void>((res) => probe.close(() => res()));

    const events: EgressListenerEvent[] = [];
    const listener = await makeListener({
      upstreamPort: deadPort,
      onEvent: (e) => events.push(e),
    });
    const { closed } = await driveClient(
      listener.address().port,
      [buildClientHello("api.test.local")],
      1,
    );
    expect(closed).toBe(true);
    expect(events[0]?.kind).toBe("tunnel-error");
  });
});

describe("transparent egress listener — plain HTTP path", () => {
  it("routes by Host header and splices the full request", async () => {
    const upstream = await startTcpEcho();
    const events: EgressListenerEvent[] = [];
    const listener = await makeListener({
      upstreamPort: upstream.port,
      onEvent: (e) => events.push(e),
    });
    const request = Buffer.from(
      "GET /v1/ping HTTP/1.1\r\nHost: api.test.local\r\nUser-Agent: axios\r\n\r\n",
      "latin1",
    );
    const { received } = await driveClient(listener.address().port, [request], request.length);
    expect(received.equals(request)).toBe(true);
    expect(events).toEqual([{ kind: "tunnel-opened", target: `api.test.local:${upstream.port}` }]);
  });

  it("strips the port from the Host header before the SSRF floor", async () => {
    const upstream = await startTcpEcho();
    const seenHosts: string[] = [];
    const listener = await makeListener({
      upstreamPort: upstream.port,
      isBlockedHostFn: (host) => {
        seenHosts.push(host);
        return false;
      },
    });
    const request = Buffer.from("GET / HTTP/1.1\r\nHost: api.test.local:8080\r\n\r\n", "latin1");
    await driveClient(listener.address().port, [request], request.length);
    // The floor sees the bare host (literal layer first, then the
    // resolve-and-pin layer re-checks host + resolved IP) — never `host:port`.
    expect(seenHosts[0]).toBe("api.test.local");
    expect(seenHosts.some((h) => h.includes(":"))).toBe(false);
  });

  it("destroys a request without a Host header", async () => {
    const events: EgressListenerEvent[] = [];
    const listener = await makeListener({ onEvent: (e) => events.push(e) });
    const request = Buffer.from("GET / HTTP/1.0\r\nUser-Agent: legacy\r\n\r\n", "latin1");
    const { closed, received } = await driveClient(listener.address().port, [request], 1);
    expect(closed).toBe(true);
    expect(received.length).toBe(0);
    expect(events[0]?.kind).toBe("tunnel-refused");
    expect(events[0]?.reason).toBe("no-host-header");
  });
});
