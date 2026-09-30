// SPDX-License-Identifier: Apache-2.0

/**
 * A TCP relay that delays every chunk by a fixed one-way latency, in both
 * directions. Between the platform and its PostgreSQL / Redis it turns a
 * loopback round trip (~0.1 ms) into a production-like one: on a laptop a query
 * is otherwise nearly free, which hides the cost of every serial await.
 *
 * Bytes keep their order and are never dropped: a close travels the same delay
 * as the data before it (a connection's last message still arrives), and a peer
 * that cannot take more pauses reading on the other side until it drains.
 */

import type { Socket } from "bun";

interface Side {
  /** The other socket of the pair; null until the upstream connection opens. */
  peer: Socket<Side> | null;
  /** Read from this socket, due at the peer at `due`; `null` marks this socket's close. */
  queue: { due: number; data: Uint8Array | null }[];
  timer: ReturnType<typeof setTimeout> | null;
  /** Bytes being written TO this socket that its buffer refused, retried on `drain`. */
  outbox: Uint8Array[];
  /** The peer closed: end this socket once the outbox is flushed. */
  ending: boolean;
  closed: boolean;
}

const newSide = (peer: Socket<Side> | null): Side => ({
  peer,
  queue: [],
  timer: null,
  outbox: [],
  ending: false,
  closed: false,
});

function enqueue(from: Side, data: Uint8Array | null, oneWayMs: number) {
  from.queue.push({ due: performance.now() + oneWayMs, data });
  schedule(from);
}

function schedule(from: Side) {
  const head = from.queue[0];
  if (from.timer || !from.peer || !head) return;
  from.timer = setTimeout(
    () => {
      from.timer = null;
      const now = performance.now();
      while (from.queue[0] && from.queue[0].due <= now) {
        deliver(from.peer!, from.queue.shift()!.data);
      }
      schedule(from);
    },
    Math.max(0, head.due - performance.now()),
  );
}

function deliver(to: Socket<Side>, data: Uint8Array | null) {
  const side = to.data;
  if (side.closed) return;
  if (data === null) {
    side.ending = true;
    if (side.outbox.length === 0) to.end();
    return;
  }
  if (side.outbox.length === 0) {
    const written = to.write(data);
    if (written < 0 || written === data.length) return;
    data = data.subarray(written);
  }
  side.outbox.push(data);
  side.peer?.pause();
}

function drain(sock: Socket<Side>) {
  const side = sock.data;
  while (side.outbox.length > 0) {
    const head = side.outbox[0]!;
    const written = sock.write(head);
    if (written < 0) return;
    if (written < head.length) {
      side.outbox[0] = head.subarray(written);
      return;
    }
    side.outbox.shift();
  }
  if (side.ending) sock.end();
  else side.peer?.resume();
}

export interface LatencyProxy {
  port: number;
  stop(): void;
}

/** Listens on 127.0.0.1:`listenPort` (0 = any free port) and relays to 127.0.0.1:`targetPort`. */
export function startLatencyProxy(
  listenPort: number,
  targetPort: number,
  oneWayMs: number,
): LatencyProxy {
  const closed = (sock: Socket<Side>) => {
    if (sock.data.closed) return;
    sock.data.closed = true;
    enqueue(sock.data, null, oneWayMs);
  };
  const handlers = {
    data(sock: Socket<Side>, data: Uint8Array) {
      // Copied: the runtime may reuse the chunk's memory once this returns.
      enqueue(sock.data, new Uint8Array(data), oneWayMs);
    },
    drain,
    close: closed,
    error: closed,
  };
  const server = Bun.listen<Side>({
    hostname: "127.0.0.1",
    port: listenPort,
    socket: {
      ...handlers,
      async open(client) {
        client.data = newSide(null);
        try {
          client.data.peer = await Bun.connect<Side>({
            hostname: "127.0.0.1",
            port: targetPort,
            data: newSide(client),
            socket: handlers,
          });
        } catch {
          client.end();
          return;
        }
        // What the client sent while the upstream was connecting.
        schedule(client.data);
      },
    },
  });
  return { port: server.port, stop: () => server.stop(true) };
}
