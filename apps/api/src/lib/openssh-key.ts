// SPDX-License-Identifier: Apache-2.0

/**
 * Ed25519 key pairs in the two encodings OpenSSH actually reads.
 *
 * Why this file exists at all: `node:crypto` can generate ed25519 and export
 * PKCS#8, but OpenSSH REFUSES PKCS#8 for this curve — `ssh-keygen -y` on such
 * a file answers `invalid format`. Unlike RSA and ECDSA, ed25519 has no
 * traditional PEM form, and OpenSSH reads only its own `OPENSSH PRIVATE KEY`
 * container (PROTOCOL.key). So the choice is between shelling out to
 * `ssh-keygen` — which would put an openssh-client in the platform image for
 * this one call — and encoding the container here. It is fifty lines of
 * length-prefixed fields, so it is encoded here.
 *
 * Nothing in this file is secret-aware: minting a pair is pure computation.
 * Where the private half then goes (the credential keyring, never the browser)
 * is the caller's business.
 */

import { generateKeyPairSync, randomBytes, createHash } from "node:crypto";

/**
 * An SSH wire string: a 4-byte big-endian length, then the bytes. Every
 * field of both encodings below is one of these, which is most of why the
 * format is short enough to write out.
 */
function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length);
  return Buffer.concat([len, bytes]);
}

/** The key types `ssh-keyscan` can emit — used to spot its host column. */
const KEY_TYPE_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))$/;

function uint32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/** The `ssh-ed25519 <base64>` blob shared by authorized_keys and known_hosts. */
function publicKeyBlob(rawPublicKey: Buffer): Buffer {
  return Buffer.concat([sshString("ssh-ed25519"), sshString(rawPublicKey)]);
}

export interface OpenSshKeyPair {
  /** PEM-armoured `OPENSSH PRIVATE KEY`. Feed to `ssh -i`. */
  privateKey: string;
  /** One `authorized_keys` line: `ssh-ed25519 <base64> <comment>`. */
  publicKey: string;
  /** `SHA256:…` over the public blob — what `ssh-keygen -l` prints. */
  fingerprint: string;
}

/**
 * Mint an ed25519 pair. The comment is cosmetic (it rides along in
 * `authorized_keys` so an operator reading the file knows where the key came
 * from) and is NOT part of the key material.
 */
export function generateOpenSshEd25519KeyPair(comment: string): OpenSshKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  // Both DER encodings are fixed-length for this curve — SPKI is 44 bytes
  // (12-byte header + the 32-byte point) and PKCS#8 is 48 (16-byte header +
  // the 32-byte seed) — so the material is the tail in each case.
  const rawPublicKey = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);
  const seed = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(-32);

  const blob = publicKeyBlob(rawPublicKey);

  // The unencrypted private section. `checkint` is written twice: on decrypt
  // OpenSSH compares the two copies to tell a wrong passphrase from a corrupt
  // file. With cipher `none` nothing is encrypted, so it only has to
  // round-trip — but it must still be there, and the two must match.
  const checkint = randomBytes(4);
  let privateSection = Buffer.concat([
    checkint,
    checkint,
    sshString("ssh-ed25519"),
    sshString(rawPublicKey),
    // Ed25519's private field is seed || public, not the seed alone.
    sshString(Buffer.concat([seed, rawPublicKey])),
    sshString(comment),
  ]);

  // Pad to the cipher block size with the bytes 1, 2, 3, … OpenSSH uses 8 for
  // cipher `none`, and rejects a file whose padding is not this exact run.
  const blockSize = 8;
  const padding = (blockSize - (privateSection.length % blockSize)) % blockSize;
  if (padding > 0) {
    privateSection = Buffer.concat([
      privateSection,
      Buffer.from(Array.from({ length: padding }, (_, i) => i + 1)),
    ]);
  }

  const container = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "binary"),
    sshString("none"), // ciphername
    sshString("none"), // kdfname
    sshString(""), // kdfoptions
    uint32(1), // number of keys
    sshString(blob),
    sshString(privateSection),
  ]);

  // OpenSSH wraps the base64 at 70 columns. Longer lines load fine, but a
  // minted key is going to be read by humans comparing it against files
  // `ssh-keygen` wrote, so it matches byte for byte.
  const wrapped = container.toString("base64").replace(/(.{70})/g, "$1\n");
  const privatePem =
    "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
    wrapped +
    (wrapped.endsWith("\n") ? "" : "\n") +
    "-----END OPENSSH PRIVATE KEY-----\n";

  return {
    privateKey: privatePem,
    publicKey: `ssh-ed25519 ${blob.toString("base64")} ${comment}`,
    fingerprint: fingerprintFromBlob(blob),
  };
}

/**
 * Read the PUBLIC half back out of an `OPENSSH PRIVATE KEY` this file wrote.
 *
 * No cryptography: the `openssh-key-v1` container carries the public blob and
 * the comment in the clear beside the private one (PROTOCOL.key — that is how
 * `ssh-keygen -y` answers instantly on an unencrypted key). So the authorized_keys
 * line a connection installed is RECOVERABLE from what the keyring already
 * holds, which is why nothing persists it: a stored copy could drift from the
 * key it claims to describe, and a derived one cannot.
 *
 * Only the `cipher: none` container this file mints is in scope. An encrypted
 * key, or any other shape, is refused rather than half-parsed.
 */
export function publicKeyFromOpenSshPrivateKey(pem: string): string {
  const body = pem
    .replace("-----BEGIN OPENSSH PRIVATE KEY-----", "")
    .replace("-----END OPENSSH PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const buf = Buffer.from(body, "base64");
  const magic = "openssh-key-v1\0";
  if (buf.subarray(0, magic.length).toString("binary") !== magic) {
    throw new Error("not an OPENSSH PRIVATE KEY container");
  }

  let at = magic.length;
  const readString = (): Buffer => {
    if (at + 4 > buf.length) throw new Error("truncated OPENSSH key container");
    const len = buf.readUInt32BE(at);
    at += 4;
    if (at + len > buf.length) throw new Error("truncated OPENSSH key container");
    const out = buf.subarray(at, at + len);
    at += len;
    return out;
  };

  const cipher = readString().toString("utf8");
  readString(); // kdfname
  readString(); // kdfoptions
  if (cipher !== "none") throw new Error(`encrypted OPENSSH key (cipher ${cipher})`);
  if (at + 4 > buf.length) throw new Error("truncated OPENSSH key container");
  const keyCount = buf.readUInt32BE(at);
  at += 4;
  if (keyCount !== 1) throw new Error(`expected one key in the container, found ${keyCount}`);

  const blob = readString();
  const privateSection = readString();

  // The comment lives in the private section, after the two checkints and the
  // keytype / public / private fields. It is part of the authorized_keys line
  // this connection installed, so the line cannot be rebuilt without it.
  let p = 8;
  const readFrom = (): Buffer => {
    if (p + 4 > privateSection.length) throw new Error("truncated OPENSSH private section");
    const len = privateSection.readUInt32BE(p);
    p += 4;
    if (p + len > privateSection.length) throw new Error("truncated OPENSSH private section");
    const out = privateSection.subarray(p, p + len);
    p += len;
    return out;
  };
  const keyType = readFrom().toString("utf8");
  readFrom(); // public
  readFrom(); // private
  const comment = readFrom().toString("utf8");

  return `${keyType} ${blob.toString("base64")}${comment ? ` ${comment}` : ""}`;
}

/** `SHA256:…`, base64 without padding — the form `ssh-keygen -l` prints. */
function fingerprintFromBlob(blob: Buffer): string {
  const digest = createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  return `SHA256:${digest}`;
}

/**
 * Fingerprint an `ssh-ed25519 AAAA…` / `ssh-rsa AAAA…` line the way
 * `ssh-keygen -l` does: SHA-256 over the DECODED blob, not over the text.
 * Accepts a bare `<type> <base64>` pair or a full `ssh-keyscan` line whose
 * first column is the host.
 */
export function fingerprintPublicKey(line: string): string {
  const fields = line.trim().split(/\s+/);
  // `host type base64` from ssh-keyscan, or `type base64 [comment]` bare. Both
  // can be three fields, so the host column is detected by what FOLLOWS it
  // being a key type — not by the shape of the line.
  const start = fields.length >= 3 && KEY_TYPE_RE.test(fields[1] ?? "") ? 1 : 0;
  const base64 = fields[start + 1];
  if (!base64 || !/^[A-Za-z0-9+/]+=*$/.test(base64)) {
    throw new Error("not an SSH public key line");
  }
  return fingerprintFromBlob(Buffer.from(base64, "base64"));
}
