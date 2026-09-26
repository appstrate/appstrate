// SPDX-License-Identifier: Apache-2.0

/**
 * Hand-built RFC 1035 queries for the DNS responder tests, exchanged over a
 * real UDP socket on 127.0.0.1.
 */

import { createSocket } from "node:dgram";

/** Build a standard single-question DNS query packet. */
export function buildQuery(name: string, qtype: number, id = 0x1234): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // RD
  header.writeUInt16BE(1, 4); // QDCOUNT
  const labels = name.split(".").map((l) => {
    const b = Buffer.from(l, "latin1");
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  const tail = Buffer.alloc(5);
  tail.writeUInt8(0, 0); // root label
  tail.writeUInt16BE(qtype, 1);
  tail.writeUInt16BE(1, 3); // CLASS IN
  return Buffer.concat([header, ...labels, tail]);
}

/** Send a packet and await the first reply (or timeout → null). */
export async function exchange(
  port: number,
  packet: Buffer,
  timeoutMs = 1_000,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const client = createSocket("udp4");
    const timer = setTimeout(() => {
      client.close();
      resolve(null);
    }, timeoutMs);
    client.on("message", (msg) => {
      clearTimeout(timer);
      client.close();
      resolve(msg);
    });
    client.send(packet, port, "127.0.0.1");
  });
}
