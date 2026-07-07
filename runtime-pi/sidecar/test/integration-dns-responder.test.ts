// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the per-run DNS responder (#779) — the resolver half of the
 * transparent egress plane. Real UDP sockets on 127.0.0.1, ephemeral
 * ports; queries are hand-built RFC 1035 packets.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { createSocket } from "node:dgram";

import {
  createIntegrationDnsResponder,
  type DnsResponderHandle,
  type DnsResponderEvent,
} from "../integration-dns-responder.ts";

const openHandles: DnsResponderHandle[] = [];

afterEach(async () => {
  for (const h of openHandles.splice(0)) {
    await h.close().catch(() => {});
  }
});

async function makeResponder(
  answerIpv4 = "10.20.0.2",
  onEvent?: (e: DnsResponderEvent) => void,
): Promise<DnsResponderHandle> {
  const handle = createIntegrationDnsResponder({
    answerIpv4,
    host: "127.0.0.1",
    port: 0,
    ...(onEvent ? { onEvent } : {}),
  });
  openHandles.push(handle);
  await handle.ready;
  return handle;
}

/** Build a standard single-question DNS query packet. */
function buildQuery(name: string, qtype: number, id = 0x1234): Buffer {
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
async function exchange(port: number, packet: Buffer, timeoutMs = 1_000): Promise<Buffer | null> {
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

describe("integration-dns-responder", () => {
  it("answers an A query with the configured sidecar IP", async () => {
    const responder = await makeResponder("10.20.0.2");
    const reply = await exchange(responder.address().port, buildQuery("api.intuit.com", 1));
    expect(reply).not.toBeNull();
    const r = reply!;
    expect(r.readUInt16BE(0)).toBe(0x1234); // id echoed
    expect(r.readUInt16BE(2) & 0x8000).toBe(0x8000); // QR=response
    expect(r.readUInt16BE(2) & 0x000f).toBe(0); // RCODE 0
    expect(r.readUInt16BE(6)).toBe(1); // ANCOUNT
    // Answer RDATA = last 4 bytes of the packet (single A record).
    expect([...r.subarray(r.length - 4)]).toEqual([10, 20, 0, 2]);
  });

  it("answers AAAA with NOERROR and zero answers (forces IPv4 fallback)", async () => {
    const responder = await makeResponder();
    const reply = await exchange(responder.address().port, buildQuery("api.intuit.com", 28));
    expect(reply).not.toBeNull();
    const r = reply!;
    expect(r.readUInt16BE(2) & 0x000f).toBe(0); // RCODE 0
    expect(r.readUInt16BE(6)).toBe(0); // ANCOUNT 0
  });

  it("drops malformed packets without replying", async () => {
    const events: DnsResponderEvent[] = [];
    const responder = await makeResponder("10.20.0.2", (e) => events.push(e));
    const reply = await exchange(responder.address().port, Buffer.from("nonsense"), 300);
    expect(reply).toBeNull();
    expect(events).toEqual([{ kind: "query-dropped", name: "" }]);
  });

  it("emits query-answered with the lowercased name", async () => {
    const events: DnsResponderEvent[] = [];
    const responder = await makeResponder("10.20.0.2", (e) => events.push(e));
    await exchange(responder.address().port, buildQuery("API.Example.COM", 1));
    expect(events).toEqual([{ kind: "query-answered", name: "api.example.com", qtype: 1 }]);
  });

  it("rejects a malformed answer IP at construction", () => {
    expect(() => createIntegrationDnsResponder({ answerIpv4: "sidecar", port: 0 })).toThrow(
      /invalid answer IPv4/,
    );
  });
});
