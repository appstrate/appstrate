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
import { buildClientHello } from "./helpers/tls-client-hello.ts";

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

type PeerPolicy = { allowsAuthority(host: string, port: number): boolean };
const allowAll: PeerPolicy = { allowsAuthority: () => true };

async function makeListener(
  opts: {
    upstreamPort?: number;
    onEvent?: (e: EgressListenerEvent) => void;
    isBlockedHostFn?: (host: string) => boolean;
    resolveHostFn?: (host: string) => Promise<string[]>;
    policyForPeer?: (remoteAddress: string) => Promise<PeerPolicy | null>;
  } = {},
): Promise<TransparentListenerHandle> {
  const listener = createTransparentEgressListener({
    host: "127.0.0.1",
    port: 0,
    isBlockedHostFn: opts.isBlockedHostFn ?? (() => false),
    resolveHostFn: opts.resolveHostFn ?? (async () => ["127.0.0.1"]),
    policyForPeer: opts.policyForPeer ?? (async () => allowAll),
    ...(opts.upstreamPort !== undefined ? { upstreamPort: opts.upstreamPort } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  });
  openListeners.push(listener);
  await listener.ready;
  return listener;
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

  it("refuses a host outside the peer's policy without ever resolving it", async () => {
    const upstream = await startTcpEcho();
    const events: EgressListenerEvent[] = [];
    const resolved: string[] = [];
    const listener = await makeListener({
      upstreamPort: upstream.port,
      policyForPeer: async () => ({ allowsAuthority: (host) => host === "allowed.test.local" }),
      resolveHostFn: async (host) => {
        resolved.push(host);
        return ["127.0.0.1"];
      },
      onEvent: (e) => events.push(e),
    });
    const { closed } = await driveClient(
      listener.address().port,
      [buildClientHello("denied.test.local")],
      1,
    );
    expect(closed).toBe(true);
    expect(events[0]?.reason).toBe("not-authorized");
    expect(resolved).toEqual([]);
    expect(upstream.received.length).toBe(0);
  });

  it("checks the policy against the listener's upstream port", async () => {
    const upstream = await startTcpEcho();
    const events: EgressListenerEvent[] = [];
    const seen: Array<[string, number]> = [];
    const listener = await makeListener({
      upstreamPort: upstream.port,
      policyForPeer: async () => ({
        allowsAuthority: (host, port) => {
          seen.push([host, port]);
          return port === 443;
        },
      }),
      onEvent: (e) => events.push(e),
    });
    const { closed } = await driveClient(
      listener.address().port,
      [buildClientHello("api.test.local")],
      1,
    );
    expect(closed).toBe(true);
    expect(seen).toEqual([["api.test.local", upstream.port]]);
    expect(events[0]?.reason).toBe("not-authorized");
  });

  it("refuses a peer with no egress policy (unknown runner / agent)", async () => {
    const upstream = await startTcpEcho();
    const events: EgressListenerEvent[] = [];
    const peers: string[] = [];
    const resolved: string[] = [];
    const listener = await makeListener({
      upstreamPort: upstream.port,
      policyForPeer: async (ip) => {
        peers.push(ip);
        return null;
      },
      resolveHostFn: async (host) => {
        resolved.push(host);
        return ["127.0.0.1"];
      },
      onEvent: (e) => events.push(e),
    });
    const { closed, received } = await driveClient(
      listener.address().port,
      [buildClientHello("api.test.local")],
      1,
    );
    expect(closed).toBe(true);
    expect(received.length).toBe(0);
    expect(peers).toEqual(["127.0.0.1"]);
    expect(resolved).toEqual([]);
    expect(upstream.received.length).toBe(0);
    expect(events).toEqual([
      {
        kind: "tunnel-refused",
        target: `<unknown>:${upstream.port}`,
        reason: "peer-not-allowed",
        peer: "127.0.0.1",
      },
    ]);
  });

  it("refuses (fails closed) when the peer lookup throws", async () => {
    const events: EgressListenerEvent[] = [];
    const listener = await makeListener({
      policyForPeer: async () => {
        throw new Error("docker network inspect failed");
      },
      onEvent: (e) => events.push(e),
    });
    const { closed } = await driveClient(
      listener.address().port,
      [buildClientHello("api.test.local")],
      1,
    );
    expect(closed).toBe(true);
    expect(events[0]?.reason).toBe("peer-not-allowed");
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
