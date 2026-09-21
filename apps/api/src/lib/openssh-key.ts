// SPDX-License-Identifier: Apache-2.0

/**
 * Ed25519 keys in the encodings OpenSSH reads. `node:crypto` exports PKCS#8,
 * which OpenSSH refuses for ed25519; it reads only its own `OPENSSH PRIVATE KEY`
 * container (PROTOCOL.key), encoded here rather than shipping openssh-client.
 */

import { generateKeyPairSync, randomBytes, createHash } from "node:crypto";

/** An SSH wire string: a 4-byte big-endian length, then the bytes. */
function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length);
  return Buffer.concat([len, bytes]);
}

function uint32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/** The `ssh-ed25519 <base64>` blob shared by authorized_keys and known_hosts. */
function publicKeyBlob(rawPublicKey: Buffer): Buffer {
  return Buffer.concat([sshString("ssh-ed25519"), sshString(rawPublicKey)]);
}

/**
 * Mint an ed25519 pair as a PEM `OPENSSH PRIVATE KEY` (comment `appstrate`).
 * The public half is derived from it by {@link publicKeyFromOpenSshPrivateKey}.
 */
export function generateOpenSshEd25519PrivateKey(): string {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  // Both DER encodings are fixed-length for this curve (SPKI 44, PKCS#8 48),
  // so the 32-byte material is the tail in each case.
  const rawPublicKey = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);
  const seed = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(-32);

  const blob = publicKeyBlob(rawPublicKey);

  // Two matching `checkint`s: required even under cipher `none`.
  const checkint = randomBytes(4);
  let privateSection = Buffer.concat([
    checkint,
    checkint,
    sshString("ssh-ed25519"),
    sshString(rawPublicKey),
    // Ed25519's private field is seed || public, not the seed alone.
    sshString(Buffer.concat([seed, rawPublicKey])),
    sshString("appstrate"),
  ]);

  // Pad to the block size with the bytes 1, 2, 3, … — OpenSSH uses 8 for
  // cipher `none` and rejects padding that is not this exact run.
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

  // 70 columns, like `ssh-keygen`.
  const wrapped = container.toString("base64").replace(/(.{70})/g, "$1\n");
  return (
    "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
    wrapped +
    (wrapped.endsWith("\n") ? "" : "\n") +
    "-----END OPENSSH PRIVATE KEY-----\n"
  );
}

/** A forward cursor over the length-prefixed fields of a container. */
function reader(buf: Buffer, at = 0) {
  const need = (n: number) => {
    if (at + n > buf.length) throw new Error("truncated OPENSSH key container");
  };
  return {
    string(): Buffer {
      need(4);
      const len = buf.readUInt32BE(at);
      at += 4;
      need(len);
      const out = buf.subarray(at, at + len);
      at += len;
      return out;
    },
    uint32(): number {
      need(4);
      const n = buf.readUInt32BE(at);
      at += 4;
      return n;
    },
  };
}

/**
 * The public half of an unencrypted `OPENSSH PRIVATE KEY`, as exactly
 * `ssh-ed25519 <base64>`. REBUILT, never echoed (it lands in a root script):
 * the blob must be byte-exactly `ssh-ed25519 || <32-byte point>` and the
 * comment is never read.
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

  const r = reader(buf, magic.length);
  const cipher = r.string().toString("utf8");
  r.string(); // kdfname
  r.string(); // kdfoptions
  if (cipher !== "none") throw new Error(`encrypted OPENSSH key (cipher ${cipher})`);
  const keyCount = r.uint32();
  if (keyCount !== 1) throw new Error(`expected one key in the container, found ${keyCount}`);

  const blob = r.string();
  const privateSection = r.string();

  // Past the two checkints, the private section repeats the key type.
  const priv = reader(privateSection, 8);
  if (priv.string().toString("utf8") !== "ssh-ed25519") {
    throw new Error("not an ed25519 OPENSSH key");
  }

  // Rebuilt and compared, so a trailing byte or a short point fails here.
  const pub = reader(blob);
  pub.string(); // type — proved by the rebuild, not by reading it
  const point = pub.string();
  if (point.length !== 32 || !publicKeyBlob(point).equals(blob)) {
    throw new Error("malformed ed25519 public blob");
  }

  return `ssh-ed25519 ${blob.toString("base64")}`;
}

/** The public-key types the platform pins a host by. */
export type PublicKeyType = "ssh-ed25519" | "ssh-rsa";

/** The manifest's `host_key` pattern, byte for byte. */
const PUBLIC_KEY_LINE_RE = /^(ssh-ed25519|ssh-rsa) ([A-Za-z0-9+/]+=*)$/;

/**
 * Parse `<type> <base64>` exactly as the manifest's `host_key` pattern admits
 * it (nothing trimmed), or null. The blob's own type must match the text, or
 * the install block would read the wrong `/etc/ssh` file.
 */
export function parsePublicKeyLine(line: string): { type: PublicKeyType; base64: string } | null {
  const match = PUBLIC_KEY_LINE_RE.exec(line);
  if (!match) return null;
  // The alternation IS `PublicKeyType`, so group 1 is one of its two members.
  const type = match[1] as PublicKeyType;
  const base64 = match[2]!;
  try {
    if (reader(Buffer.from(base64, "base64")).string().toString("utf8") !== type) return null;
  } catch {
    return null;
  }
  return { type, base64 };
}

/**
 * Fingerprint a `<type> <base64>` line as `ssh-keygen -l` prints it: SHA-256
 * over the DECODED blob, base64 without padding.
 */
export function fingerprintPublicKey(line: string): string {
  const parsed = parsePublicKeyLine(line);
  if (!parsed) throw new Error("not an SSH public key line");
  const digest = createHash("sha256").update(Buffer.from(parsed.base64, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}
