// SPDX-License-Identifier: Apache-2.0

/**
 * `closeWith` (#1819): how one side of a relay tears down the other. A clean
 * end/close of `from` flushes what is still queued for `to`, then destroys it;
 * an error on `from`, or a `to` still connecting, destroys `to` at once.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { createServer as netCreateServer, connect as netConnect, Socket } from "node:net";
import type { Server as NetServer } from "node:net";

import { closeWith } from "../connect-tunnel.ts";

const servers: NetServer[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((res) => s.close(() => res()))));
});

/** Far beyond what the kernel buffers for a reader that is not reading. */
const PAYLOAD_BYTES = 32 * 1024 * 1024;

/** A server on an ephemeral 127.0.0.1 port; resolves with the port. */
function listen(onAccept: (socket: Socket) => void = () => {}): Promise<number> {
  return new Promise((resolve) => {
    const server = netCreateServer((socket) => {
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

/** A connected TCP pair: the accepted side and the client side. */
async function tcpPair(): Promise<{ accepted: Socket; client: Socket }> {
  let accept!: (socket: Socket) => void;
  const accepted = new Promise<Socket>((res) => (accept = res));
  const client = netConnect(await listen((s) => accept(s)), "127.0.0.1");
  sockets.push(client);
  client.on("error", () => {});
  return { accepted: await accepted, client };
}

/** `to` with most of a large payload queued in userland: its reader (`peer`) is paused. */
async function backedUpSocket(): Promise<{ to: Socket; peer: Socket }> {
  const { accepted: to, client: peer } = await tcpPair();
  peer.pause();
  to.write(Buffer.alloc(PAYLOAD_BYTES, 0x61)); // no drain wait
  return { to, peer };
}

describe("closeWith", () => {
  it("flushes everything queued for `to` before destroying it when `from` ends cleanly", async () => {
    const { to, peer } = await backedUpSocket();
    const { accepted: from, client: fromPeer } = await tcpPair();
    closeWith(from, to);

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

    if (!to.destroyed) await new Promise<void>((res) => to.once("close", () => res()));
    expect(to.destroyed).toBe(true);
  }, 30_000);

  it("destroys `to` at once, queued bytes and all, on an error on `from`", async () => {
    const { to } = await backedUpSocket();
    const from = new Socket();
    sockets.push(from);
    closeWith(from, to);

    from.emit("error", new Error("upstream reset"));
    expect(to.destroyed).toBe(true);
  });

  it("destroys a `to` still connecting", async () => {
    const to = netConnect(await listen(), "127.0.0.1");
    sockets.push(to);
    to.on("error", () => {});
    const from = new Socket();
    sockets.push(from);
    closeWith(from, to);

    expect(to.connecting).toBe(true);
    from.emit("end");
    expect(to.destroyed).toBe(true);
  });
});
