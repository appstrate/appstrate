// SPDX-License-Identifier: Apache-2.0

/**
 * Hand-built TLS ClientHello records for the egress listener tests — the
 * listeners never terminate TLS, so a byte-exact buffer is all they read.
 */

const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);

/** Wrap `fragment` in one TLS handshake record header (type 0x16, legacy version 0x0301). */
export function tlsRecord(fragment: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(fragment.length), fragment]);
}

/**
 * A minimal TLS 1.2/1.3-shaped ClientHello record (RFC 8446 §4.1.2), with a
 * `server_name` extension (RFC 6066 §3) unless `sni` is null.
 */
export function buildClientHello(sni: string | null): Buffer {
  let extensions = Buffer.alloc(0);
  if (sni !== null) {
    const host = Buffer.from(sni, "utf-8");
    const entry = Buffer.concat([Buffer.from([0x00]), u16(host.length), host]); // host_name
    const list = Buffer.concat([u16(entry.length), entry]);
    extensions = Buffer.concat([u16(0x0000), u16(list.length), list]);
  }
  const body = Buffer.concat([
    u16(0x0303), // legacy_version
    Buffer.alloc(32), // random
    Buffer.from([0x00]), // session_id length
    Buffer.concat([u16(2), u16(0x1301)]), // one cipher suite
    Buffer.from([0x01, 0x00]), // one compression method (null)
    u16(extensions.length),
    extensions,
  ]);
  return tlsRecord(Buffer.concat([Buffer.from([0x01, 0x00]), u16(body.length), body]));
}
