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
 *
 * The reader is tested the other way round: containers forged HERE, with the
 * inner fields a caller of `POST .../connect/fields` gets to choose, because
 * what comes out of that parser is interpolated into a script run as root.
 */

import { describe, it, expect } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateOpenSshEd25519KeyPair,
  fingerprintPublicKey,
  publicKeyFromOpenSshPrivateKey,
} from "../../src/lib/openssh-key.ts";

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

  it("carries the same public point in the blob, the private section and the derived line", () => {
    const kp = generateOpenSshEd25519KeyPair("appstrate");
    const c = decodeContainer(kp.privateKey);

    // Public blob: string "ssh-ed25519", string <32-byte point>.
    const pub = reader(c.publicBlob);
    const type = pub.string();
    const point = pub.string();
    expect(type.toString()).toBe("ssh-ed25519");
    expect(point.length).toBe(32);
    expect(pub.offset).toBe(c.publicBlob.length);

    // The line the platform derives must encode exactly that blob.
    const [, derivedBase64] = publicKeyFromOpenSshPrivateKey(kp.privateKey).split(/\s+/);
    expect(Buffer.from(derivedBase64!, "base64").equals(c.publicBlob)).toBe(true);

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

  it("mints a different key every call", () => {
    const a = generateOpenSshEd25519KeyPair("appstrate");
    const b = generateOpenSshEd25519KeyPair("appstrate");
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(publicKeyFromOpenSshPrivateKey(a.privateKey)).not.toBe(
      publicKeyFromOpenSshPrivateKey(b.privateKey),
    );
  });
});

// ─────────────────── containers forged with hostile fields ───────────────────

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

/**
 * An `openssh-key-v1` container with arbitrary inner fields — what a caller of
 * `POST .../connect/fields` can store, since that door runs no provisioner and
 * the manifest's `pattern` only pins the PEM armour.
 */
function forgeContainer(
  opts: { keyType?: string; comment?: string; point?: Buffer; blob?: Buffer } = {},
): string {
  const keyType = opts.keyType ?? "ssh-ed25519";
  const point = opts.point ?? randomBytes(32);
  const blob = opts.blob ?? Buffer.concat([sshString(keyType), sshString(point)]);
  const privateSection = Buffer.concat([
    Buffer.alloc(8), // the two checkints
    sshString(keyType),
    sshString(point),
    sshString(Buffer.concat([randomBytes(32), point])),
    sshString(opts.comment ?? ""),
  ]);
  const container = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "binary"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    uint32(1),
    sshString(blob),
    sshString(privateSection),
  ]);
  return (
    "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
    container.toString("base64") +
    "\n-----END OPENSSH PRIVATE KEY-----\n"
  );
}

describe("publicKeyFromOpenSshPrivateKey", () => {
  it("returns the bare `ssh-ed25519 <base64>` pair, never the container's comment", () => {
    const kp = generateOpenSshEd25519KeyPair("appstrate @myorg/ssh");
    expect(publicKeyFromOpenSshPrivateKey(kp.privateKey)).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=*$/);
    expect(publicKeyFromOpenSshPrivateKey(kp.privateKey)).not.toContain("myorg");
  });

  it("drops a hostile comment instead of carrying it out of the container", () => {
    const pem = forgeContainer({ comment: "x'; touch /tmp/PWNED; echo '\n" });
    const line = publicKeyFromOpenSshPrivateKey(pem);
    expect(line).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=*$/);
  });

  it.each([
    ["a non-ed25519 key type", forgeContainer({ keyType: "ssh-rsa" })],
    ["a key type carrying shell syntax", forgeContainer({ keyType: "ssh-ed25519'; id; echo '" })],
    ["a short public point", forgeContainer({ point: randomBytes(31) })],
    [
      "a blob with trailing bytes",
      forgeContainer({
        blob: Buffer.concat([
          sshString("ssh-ed25519"),
          sshString(randomBytes(32)),
          Buffer.from("junk"),
        ]),
      }),
    ],
    ["a truncated public blob", forgeContainer({ blob: sshString("") })],
    ["armour with no container in it", "-----BEGIN OPENSSH PRIVATE KEY-----\nnope\n"],
  ])("refuses %s", (_label, pem) => {
    expect(() => publicKeyFromOpenSshPrivateKey(pem)).toThrow();
  });
});

describe("fingerprintPublicKey", () => {
  it("reports what ssh-keygen -l prints, over the decoded blob", () => {
    const kp = generateOpenSshEd25519KeyPair("appstrate");
    const [type, base64] = publicKeyFromOpenSshPrivateKey(kp.privateKey).split(/\s+/);
    const expected =
      "SHA256:" +
      createHash("sha256")
        .update(Buffer.from(base64!, "base64"))
        .digest("base64")
        .replace(/=+$/, "");
    expect(fingerprintPublicKey(`${type} ${base64}`)).toBe(expected);
  });

  it("accepts an ssh-rsa line", () => {
    expect(fingerprintPublicKey("ssh-rsa AAAAB3NzaC1yc2E=")).toStartWith("SHA256:");
  });

  /**
   * ONE form, `<type> <base64>` — EXACTLY the shape the manifest's `host_key`
   * pattern admits on both connection doors, down to the single space. A
   * three-column `ssh-keyscan` line, a trailing comment and a type outside the
   * two supported are all refused rather than half-read into a column that
   * happens to look like base64; so is any whitespace the pattern refuses,
   * since a reader looser than the pattern accepts values the other door does
   * not.
   */
  it.each([
    ["an ssh-keyscan line", "[example.test]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5"],
    ["a trailing comment", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 agent@host"],
    ["an unsupported type", "ecdsa-sha2-nistp256 AAAAE2VjZHNh"],
    ["a line that carries no key", "ssh-ed25519"],
    ["base64 that is not", "ssh-ed25519 not-base64!"],
    ["a tab between the columns", "ssh-ed25519\tAAAAC3NzaC1lZDI1NTE5"],
    ["a doubled space", "ssh-ed25519  AAAAC3NzaC1lZDI1NTE5"],
    ["leading whitespace", " ssh-ed25519 AAAAC3NzaC1lZDI1NTE5"],
    ["a trailing newline", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5\n"],
    ["an embedded newline", "ssh-ed25519\nAAAAC3NzaC1lZDI1NTE5"],
  ])("refuses %s", (_label, line) => {
    expect(() => fingerprintPublicKey(line)).toThrow(/not an SSH public key/);
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
      expect(out.trim()).toBe(`${publicKeyFromOpenSshPrivateKey(kp.privateKey)} appstrate`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the same fingerprint as ssh-keygen -l", async () => {
    const dir = mkdtempSync(join(tmpdir(), "appstrate-openssh-key-"));
    try {
      const kp = generateOpenSshEd25519KeyPair("appstrate");
      const pubPath = join(dir, "id_ed25519.pub");
      writeFileSync(pubPath, publicKeyFromOpenSshPrivateKey(kp.privateKey) + "\n");

      const proc = Bun.spawn([sshKeygen!, "-l", "-f", pubPath], { stdout: "pipe" });
      const out = await new Response(proc.stdout).text();
      await proc.exited;

      // `256 SHA256:… comment (ED25519)` — the fingerprint is the 2nd field.
      expect(out.trim().split(/\s+/)[1]).toBe(
        fingerprintPublicKey(publicKeyFromOpenSshPrivateKey(kp.privateKey)),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
