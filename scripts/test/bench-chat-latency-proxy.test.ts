// SPDX-License-Identifier: Apache-2.0

/**
 * The chat bench's delaying TCP relay. Its numbers are only worth something if
 * the relay is transparent apart from the delay: a reordered or dropped byte
 * corrupts a PostgreSQL / Redis session, and a close that overtakes the data
 * before it loses a connection's last message.
 */

import { afterEach, describe, it, expect } from "bun:test";
import type { Socket, TCPSocketListener } from "bun";
import { startLatencyProxy, type LatencyProxy } from "../bench/chat/latency-proxy.ts";

const ONE_WAY_MS = 25;
// Timers may fire a hair early relative to `performance.now()` on some hosts.
const TIMER_SLACK_MS = 2;

interface Peer {
  received: Uint8Array[];
  firstByteAt: number | null;
  closedAt: number | null;
  pending: Uint8Array[];
}

const newPeer = (): Peer => ({ received: [], firstByteAt: null, closedAt: null, pending: [] });

/** Write everything, resuming on `drain` when the socket's buffer is full. */
function writeAll(sock: Socket<Peer>, data: Uint8Array) {
  sock.data.pending.push(data);
  flushPending(sock);
}

function flushPending(sock: Socket<Peer>) {
  const pending = sock.data.pending;
  while (pending.length > 0) {
    const head = pending[0]!;
    const written = sock.write(head);
    if (written < head.length) {
      pending[0] = head.subarray(Math.max(0, written));
      return;
    }
    pending.shift();
  }
}

const peerHandlers = {
  data(sock: Socket<Peer>, data: Uint8Array) {
    sock.data.firstByteAt ??= performance.now();
    sock.data.received.push(new Uint8Array(data));
  },
  drain: flushPending,
  close(sock: Socket<Peer>) {
    sock.data.closedAt ??= performance.now();
  },
};

const concat = (chunks: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
};

async function until(predicate: () => boolean, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

/** A deterministic, non-repeating-looking payload, so a reordered chunk cannot compare equal. */
function payload(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let x = 2463534242;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    bytes[i] = x & 0xff;
  }
  return bytes;
}

let target: TCPSocketListener<Peer> | null = null;
let proxy: LatencyProxy | null = null;
let targetSocket: Socket<Peer> | null = null;

afterEach(() => {
  proxy?.stop();
  target?.stop(true);
  proxy = null;
  target = null;
  targetSocket = null;
});

async function connectThroughProxy(onTargetOpen?: (sock: Socket<Peer>) => void) {
  target = Bun.listen<Peer>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      ...peerHandlers,
      open(sock) {
        sock.data = newPeer();
        targetSocket = sock;
        onTargetOpen?.(sock);
      },
    },
  });
  proxy = startLatencyProxy(0, target.port, ONE_WAY_MS);
  const client = await Bun.connect<Peer>({
    hostname: "127.0.0.1",
    port: proxy.port,
    data: newPeer(),
    socket: peerHandlers,
  });
  return client;
}

describe("startLatencyProxy", () => {
  it("delays each direction by the one-way latency", async () => {
    const client = await connectThroughProxy();
    const sentAt = performance.now();
    client.write("ping");
    await until(() => targetSocket?.data.firstByteAt != null);
    const target = targetSocket!;
    expect(target.data.firstByteAt! - sentAt).toBeGreaterThanOrEqual(ONE_WAY_MS - TIMER_SLACK_MS);

    const repliedAt = performance.now();
    target.write("pong");
    await until(() => client.data.firstByteAt !== null);
    expect(client.data.firstByteAt! - repliedAt).toBeGreaterThanOrEqual(
      ONE_WAY_MS - TIMER_SLACK_MS,
    );
    expect(new TextDecoder().decode(concat(target.data.received))).toBe("ping");
    expect(new TextDecoder().decode(concat(client.data.received))).toBe("pong");
    client.end();
  });

  it("relays a large payload intact and in order, both ways, through backpressure", async () => {
    const size = 16 * 1024 * 1024;
    const up = payload(size);
    const down = payload(size).reverse();
    const client = await connectThroughProxy((sock) => {
      // A receiver that stops reading fills every buffer between it and the
      // sender, so the relay's own writes come back short and it must hold
      // the rest — and stop reading the other side — until `drain`.
      sock.pause();
      setTimeout(() => sock.resume(), 200);
      writeAll(sock, down);
    });
    client.pause();
    setTimeout(() => client.resume(), 200);
    writeAll(client, up);

    const received = (peer: Peer) => peer.received.reduce((n, c) => n + c.length, 0);
    await until(
      () => received(client.data) === size && received(targetSocket!.data) === size,
      20_000,
    );
    expect(concat(targetSocket!.data.received)).toEqual(up);
    expect(concat(client.data.received)).toEqual(down);
    client.end();
  }, 30_000);

  it("delivers the data sent before a close, then the close", async () => {
    const client = await connectThroughProxy();
    // Written and closed in the same tick: the close must not overtake the bytes.
    client.write("last message");
    client.end();
    await until(() => targetSocket?.data.closedAt != null);
    expect(new TextDecoder().decode(concat(targetSocket!.data.received))).toBe("last message");
  });

  it("closes the client when the target closes", async () => {
    const client = await connectThroughProxy((sock) => {
      sock.write("bye");
      sock.end();
    });
    await until(() => client.data.closedAt !== null);
    expect(new TextDecoder().decode(concat(client.data.received))).toBe("bye");
  });
});
