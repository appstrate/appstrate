// SPDX-License-Identifier: Apache-2.0

/**
 * The encoder in `lib/openssh-key.ts` writes a binary container that only
 * OpenSSH reads, so a test asserting "it returns a string starting with
 * -----BEGIN" would prove nothing. Two independent checks instead:
 *
 *   1. decode the container back here, field by field, WITHOUT reusing the
 *      encoder's helpers — a shared helper with an off-by-one would cancel
 *      itself out;
 *   2. hand the private key to the real `ssh-keygen -y` and require it to
 *      derive the same public line. That is the only check that speaks for
 *      OpenSSH itself, so it runs wherever the binary exists.
 */

import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateOpenSshEd25519KeyPair, fingerprintPublicKey } from "../../src/lib/openssh-key.ts";

/**
 * A forward cursor over the container. The format is a run of length-prefixed
 * fields, so reading it is a sequence of `string()` calls whose order IS the
 * assertion — a mis-ordered read desynchronises and the next length is absurd.
 */
function reader(buf: Buffer, start = 0) {
  let off = start;
  return {
    /** One SSH wire string: 4-byte big-endian length, then the bytes. */
    string(): Buffer {
      const len = buf.readUInt32BE(off);
      const from = off + 4;
      off = from + len;
      return buf.subarray(from, from + len);
    },
    uint32(): number {
      const value = buf.readUInt32BE(off);
      off += 4;
      return value;
    },
    rest(): Buffer {
      return buf.subarray(off);
    },
    get offset(): number {
      return off;
    },
  };
}

function decodeContainer(pem: string): {
  magic: string;
  cipher: string;
  kdf: string;
  keyCount: number;
  publicBlob: Buffer;
  privateSection: Buffer;
} {
  const body = pem
    .replace("-----BEGIN OPENSSH PRIVATE KEY-----", "")
    .replace("-----END OPENSSH PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const buf = Buffer.from(body, "base64");

  const magic = buf.subarray(0, 15).toString("binary");
  const r = reader(buf, 15);
  const cipher = r.string();
  const kdf = r.string();
  const kdfOpts = r.string();
  const keyCount = r.uint32();
  const pub = r.string();
  const priv = r.string();

  expect(kdfOpts.length).toBe(0);
  expect(r.offset).toBe(buf.length);
  return {
    magic,
    cipher: cipher.toString(),
    kdf: kdf.toString(),
    keyCount,
    publicBlob: pub,
    privateSection: priv,
  };
}

describe("generateOpenSshEd25519KeyPair", () => {
  it("writes the openssh-key-v1 container with an unencrypted single key", () => {
    const kp = generateOpenSshEd25519KeyPair("appstrate");
    const c = decodeContainer(kp.privateKey);

    expect(c.magic).toBe("openssh-key-v1\0");
    expect(c.cipher).toBe("none");
    expect(c.kdf).toBe("none");
    expect(c.keyCount).toBe(1);
  });

  it("carries the same public point in the blob, the private section and the .pub line", () => {
    const kp = generateOpenSshEd25519KeyPair("appstrate");
    const c = decodeContainer(kp.privateKey);

    // Public blob: string "ssh-ed25519", string <32-byte point>.
    const pub = reader(c.publicBlob);
    const type = pub.string();
    const point = pub.string();
    expect(type.toString()).toBe("ssh-ed25519");
    expect(point.length).toBe(32);
    expect(pub.offset).toBe(c.publicBlob.length);

    // The emitted authorized_keys line must encode exactly that blob.
    const [, emittedBase64] = kp.publicKey.split(/\s+/);
    expect(Buffer.from(emittedBase64!, "base64").equals(c.publicBlob)).toBe(true);

    // Private section: checkint ×2, type, point, seed||point, comment, padding.
    const sec = reader(c.privateSection);
    expect(sec.uint32()).toBe(sec.uint32());
    const pType = sec.string();
    const pPoint = sec.string();
    const secret = sec.string();
    const comment = sec.string();

    expect(pType.toString()).toBe("ssh-ed25519");
    expect(pPoint.equals(point)).toBe(true);
    // Ed25519's private field is seed || public — 64 bytes whose tail is the
    // point. A 32-byte field here would load in some clients and fail in ssh.
    expect(secret.length).toBe(64);
    expect(secret.subarray(32).equals(point)).toBe(true);
    expect(comment.toString()).toBe("appstrate");
  });

  it("pads the private section to the cipher block size with 1,2,3,…", () => {
    const kp = generateOpenSshEd25519KeyPair("a-comment-of-some-length");
    const c = decodeContainer(kp.privateKey);
    expect(c.privateSection.length % 8).toBe(0);

    // Re-walk to the end of the declared fields; whatever follows is padding.
    const sec = reader(c.privateSection, 8);
    for (let i = 0; i < 4; i++) sec.string();
    const pad = sec.rest();
    expect(pad.length).toBeLessThan(8);
    for (let i = 0; i < pad.length; i++) expect(pad[i]).toBe(i + 1);
  });

  it("reports the fingerprint ssh-keygen -l would print, over the decoded blob", () => {
    const kp = generateOpenSshEd25519KeyPair("appstrate");
    const [, base64] = kp.publicKey.split(/\s+/);
    const expected =
      "SHA256:" +
      createHash("sha256")
        .update(Buffer.from(base64!, "base64"))
        .digest("base64")
        .replace(/=+$/, "");
    expect(kp.fingerprint).toBe(expected);
    // Same answer whether it is recomputed from the line we emitted…
    expect(fingerprintPublicKey(kp.publicKey)).toBe(expected);
  });

  it("mints a different key every call", () => {
    const a = generateOpenSshEd25519KeyPair("appstrate");
    const b = generateOpenSshEd25519KeyPair("appstrate");
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });
});

describe("fingerprintPublicKey", () => {
  it("drops the host column of an ssh-keyscan line", () => {
    const kp = generateOpenSshEd25519KeyPair("appstrate");
    const [type, base64] = kp.publicKey.split(/\s+/);
    expect(fingerprintPublicKey(`[example.test]:2222 ${type} ${base64}`)).toBe(kp.fingerprint);
    expect(fingerprintPublicKey(`${type} ${base64}`)).toBe(kp.fingerprint);
  });

  it("refuses a line that carries no key", () => {
    expect(() => fingerprintPublicKey("ssh-ed25519")).toThrow(/not an SSH public key/);
  });
});

/**
 * The verdict that matters: OpenSSH's own parser. `ssh-keygen -y` reads the
 * private key and prints the public half it derives — if our container were
 * malformed in any of the ways the pure tests above cannot see, it answers
 * `invalid format` instead.
 */
const sshKeygen = Bun.which("ssh-keygen");

describe.if(sshKeygen !== null)("cross-check against the real ssh-keygen", () => {
  it("derives the same public key from our private key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "appstrate-openssh-key-"));
    try {
      const kp = generateOpenSshEd25519KeyPair("appstrate");
      const keyPath = join(dir, "id_ed25519");
      writeFileSync(keyPath, kp.privateKey, { mode: 0o600 });

      const proc = Bun.spawn([sshKeygen!, "-y", "-f", keyPath], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(`${code} ${err}`.trim()).toBe("0");

      // ssh-keygen echoes the comment it read out of the container, so the
      // whole line must match — which also proves the comment round-tripped.
      expect(out.trim()).toBe(kp.publicKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the same fingerprint as ssh-keygen -l", async () => {
    const dir = mkdtempSync(join(tmpdir(), "appstrate-openssh-key-"));
    try {
      const kp = generateOpenSshEd25519KeyPair("appstrate");
      const pubPath = join(dir, "id_ed25519.pub");
      writeFileSync(pubPath, kp.publicKey + "\n");

      const proc = Bun.spawn([sshKeygen!, "-l", "-f", pubPath], { stdout: "pipe" });
      const out = await new Response(proc.stdout).text();
      await proc.exited;

      // `256 SHA256:… comment (ED25519)` — the fingerprint is the 2nd field.
      expect(out.trim().split(/\s+/)[1]).toBe(kp.fingerprint);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
