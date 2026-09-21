// SPDX-License-Identifier: Apache-2.0

/**
 * Ed25519 key pairs in the two encodings OpenSSH actually reads. `node:crypto`
 * exports PKCS#8, which OpenSSH REFUSES for this curve (`ssh-keygen -y` answers
 * `invalid format`): ed25519 has no traditional PEM form and OpenSSH reads only
 * its own `OPENSSH PRIVATE KEY` container (PROTOCOL.key). The alternative is an
 * openssh-client in the platform image for one call, so it is encoded here.
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

export interface OpenSshKeyPair {
  /**
   * PEM-armoured `OPENSSH PRIVATE KEY`. Feed to `ssh -i`. The only half
   * returned: the container carries the public one in the clear beside it, so
   * {@link publicKeyFromOpenSshPrivateKey} derives that whenever it is needed
   * rather than a caller carrying a second copy that could drift.
   */
  privateKey: string;
}

/**
 * Mint an ed25519 pair. The comment rides inside the container for an operator
 * inspecting the key; it is not key material, and the platform never reads it
 * back (see {@link publicKeyFromOpenSshPrivateKey}).
 */
export function generateOpenSshEd25519KeyPair(comment: string): OpenSshKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  // Both DER encodings are fixed-length for this curve (SPKI 44, PKCS#8 48),
  // so the 32-byte material is the tail in each case.
  const rawPublicKey = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);
  const seed = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(-32);

  const blob = publicKeyBlob(rawPublicKey);

  // `checkint` twice: on decrypt OpenSSH compares the copies to tell a wrong
  // passphrase from a corrupt file. Under cipher `none` it only round-trips,
  // but it must be there and the two must match.
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

  // OpenSSH wraps at 70 columns. Longer lines load fine, but a minted key is
  // read by humans against files `ssh-keygen` wrote, so it matches byte for byte.
  const wrapped = container.toString("base64").replace(/(.{70})/g, "$1\n");
  const privatePem =
    "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
    wrapped +
    (wrapped.endsWith("\n") ? "" : "\n") +
    "-----END OPENSSH PRIVATE KEY-----\n";

  return { privateKey: privatePem };
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
 * Read the PUBLIC half back out of an `OPENSSH PRIVATE KEY`, as exactly
 * `ssh-ed25519 <base64>`. Only the `cipher: none` container this file mints is
 * in scope; anything else is refused rather than half-parsed. No cryptography:
 * the container carries the public blob in the clear beside the private one, so
 * an installed authorized_keys line is recoverable from the keyring and nothing
 * has to persist it.
 *
 * What comes back is REBUILT, never echoed. The container's key-type and
 * comment fields are caller-chosen (`POST .../connect/fields` imports a private
 * key without running a provisioner) and this line is interpolated into a script
 * pasted as root. So the blob must be byte-exactly `ssh-ed25519 || <32-byte
 * point>`, the private section must name the same type, and the comment is
 * never read.
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

  // Rebuilt from the 32-byte point and required to be the bytes that were
  // there, so a trailing byte or a short point fails here rather than
  // travelling on into a root script.
  const pub = reader(blob);
  pub.string(); // type — proved by the rebuild, not by reading it
  const point = pub.string();
  if (point.length !== 32 || !publicKeyBlob(point).equals(blob)) {
    throw new Error("malformed ed25519 public blob");
  }

  return `ssh-ed25519 ${blob.toString("base64")}`;
}

/** `SHA256:…`, base64 without padding — the form `ssh-keygen -l` prints. */
function fingerprintFromBlob(blob: Buffer): string {
  const digest = createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  return `SHA256:${digest}`;
}

/** The public-key types the platform pins a host by. */
export type PublicKeyType = "ssh-ed25519" | "ssh-rsa";

/** The manifest's `host_key` pattern, byte for byte. */
const PUBLIC_KEY_LINE_RE = /^(ssh-ed25519|ssh-rsa) ([A-Za-z0-9+/]+=*)$/;

/**
 * Parse the ONE public-key form the platform accepts — `<type> <base64>`,
 * EXACTLY the shape that pattern admits on both connection doors: one space, no
 * comment, no surrounding whitespace. Nothing is trimmed here, because a reader
 * looser than the pattern accepts lines the programmatic door refuses, and what
 * comes out picks a file path interpolated into a script run as root. Null for
 * anything else; each caller words its own refusal.
 */
export function parsePublicKeyLine(line: string): { type: PublicKeyType; base64: string } | null {
  const match = PUBLIC_KEY_LINE_RE.exec(line);
  if (!match) return null;
  // The alternation IS `PublicKeyType`, so group 1 is one of its two members.
  return { type: match[1] as PublicKeyType, base64: match[2]! };
}

/**
 * Fingerprint a `<type> <base64>` line the way `ssh-keygen -l` does: SHA-256
 * over the DECODED blob, not over the text.
 */
export function fingerprintPublicKey(line: string): string {
  const parsed = parsePublicKeyLine(line);
  if (!parsed) throw new Error("not an SSH public key line");
  return fingerprintFromBlob(Buffer.from(parsed.base64, "base64"));
}
