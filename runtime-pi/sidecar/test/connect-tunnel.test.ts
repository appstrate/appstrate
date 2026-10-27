// SPDX-License-Identifier: Apache-2.0

/**
 * `tieSockets` (#1819): how one side of a relay tears down the other. A close
 * flushes what is still queued for `to`, then destroys it; an error on `from`,
 * or a close while `to` is still connecting, destroys `to` at once.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { createServer as netCreateServer, connect as netConnect, Socket } from "node:net";
import type { Server as NetServer } from "node:net";

import { relaySockets, tieSockets } from "../connect-tunnel.ts";

const servers: NetServer[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((res) => s.close(() => res()))));
});

/** Far beyond what the kernel buffers for a reader that is not reading. */
const PAYLOAD_BYTES = 16 * 1024 * 1024;

/** A server on an ephemeral 127.0.0.1 port; resolves with the port. */
function listen(
  onAccept: (socket: Socket) => void = () => {},
  allowHalfOpen = false,
): Promise<number> {
  return new Promise((resolve) => {
    const server = netCreateServer({ allowHalfOpen }, (socket) => {
      sockets.push(socket);
      socket.on("error", () => {});
      onAccept(socket);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

/**
 * A connected TCP pair: the accepted side and the client side, half-open when its peer ends (the
 * accepted side too when `allowHalfOpen`).
 */
async function tcpPair(allowHalfOpen = false): Promise<{ accepted: Socket; client: Socket }> {
  let accept!: (socket: Socket) => void;
  const accepted = new Promise<Socket>((res) => (accept = res));
  const port = await listen((s) => accept(s), allowHalfOpen);
  const client = netConnect({ port, host: "127.0.0.1", allowHalfOpen: true });
  sockets.push(client);
  client.on("error", () => {});
  return { accepted: await accepted, client };
}

/**
 * `to` with most of a large payload queued in userland: its reader (`peer`) is paused, and stays
 * open once `to` ends, so only `to` itself can close their connection.
 */
async function backedUpSocket(): Promise<{ to: Socket; peer: Socket }> {
  const { accepted: to, client: peer } = await tcpPair();
  peer.pause();
  to.write(Buffer.alloc(PAYLOAD_BYTES, 0x61)); // no drain wait
  return { to, peer };
}

describe("tieSockets", () => {
  it("flushes everything queued for `to` before destroying it when `from` closes cleanly", async () => {
    const { to, peer } = await backedUpSocket();
    const { accepted: from, client: fromPeer } = await tcpPair();
    tieSockets(from, to);

    const released = new Promise<void>((res) => {
      from.once("end", () => res());
      from.once("close", () => res());
    });
    from.resume();
    fromPeer.end();
    await released;
    // The paused reader holds the queue back: `to` is ending, not destroyed.
    expect(to.destroyed).toBe(false);

    let received = 0;
    const drained = new Promise<void>((res) => {
      peer.once("end", () => res());
      peer.once("close", () => res());
    });
    peer.on("data", (chunk: Buffer) => (received += chunk.length));
    peer.resume();
    await drained;
    expect(received).toBe(PAYLOAD_BYTES);

    const closed = new Promise<boolean>((res) => {
      if (to.destroyed) res(true);
      to.once("close", () => res(true));
      setTimeout(() => res(false), 1_000);
    });
    expect(await closed).toBe(true);
  }, 15_000);

  it("destroys `to` at once, queued bytes and all, on an error on `from`", async () => {
    const { to } = await backedUpSocket();
    const from = new Socket();
    sockets.push(from);
    tieSockets(from, to);

    from.emit("error", new Error("upstream reset"));
    expect(to.destroyed).toBe(true);
  });

  it("destroys a `to` still connecting", async () => {
    const to = netConnect(await listen(), "127.0.0.1");
    sockets.push(to);
    to.on("error", () => {});
    const from = new Socket();
    sockets.push(from);
    tieSockets(from, to);

    expect(to.connecting).toBe(true);
    from.emit("close");
    expect(to.destroyed).toBe(true);
  });
});

describe("relaySockets", () => {
  it("destroys a half-open relay that stays idle, on both sides", async () => {
    const a = await tcpPair(true);
    const b = await tcpPair(true);
    relaySockets(a.accepted, b.accepted, 300);
    tieSockets(a.accepted, b.accepted);
    const closed = (s: Socket) => new Promise<void>((res) => s.once("close", () => res()));
    const bothClosed = Promise.all([closed(a.accepted), closed(b.accepted)]).then(() => true);

    a.client.end(); // relayed as a FIN to `b.client`, which never answers
    await Bun.sleep(100);
    expect([a.accepted.destroyed, b.accepted.destroyed]).toEqual([false, false]);
    expect(await Promise.race([bothClosed, Bun.sleep(1_500).then(() => false)])).toBe(true);
  });
});
