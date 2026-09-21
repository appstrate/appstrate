// SPDX-License-Identifier: Apache-2.0

/**
 * The USTAR writer feeds `docker cp -`, so the only verdict that counts is
 * what a real extractor reconstructs. These tests parse the bytes with a
 * reader written independently of the writer — a reader sharing the writer's
 * code could not catch a header the writer got wrong — and the long-path case
 * was additionally confirmed end to end against the docker daemon.
 */

import { describe, expect, it } from "bun:test";
import { buildUstar, splitUstarPath, type UstarEntry } from "../ustar.ts";

const BLOCK = 512;

interface ParsedEntry {
  path: string;
  mode: number;
  uid: number;
  gid: number;
  type: "file" | "directory";
  content: string;
}

/** Independent USTAR reader, including the `prefix` + `name` join. */
function parse(bytes: Uint8Array): Map<string, ParsedEntry> {
  const dec = new TextDecoder();
  const out = new Map<string, ParsedEntry>();
  const field = (off: number, at: number, len: number) =>
    dec
      .decode(bytes.subarray(off + at, off + at + len))
      .replace(/\0.*$/s, "")
      .trim();

  for (let off = 0; off + BLOCK <= bytes.length;) {
    const name = field(off, 0, 100);
    if (name === "") break;
    const prefix = field(off, 345, 155);
    const size = parseInt(field(off, 124, 12) || "0", 8);
    const typeflag = field(off, 156, 1);
    const path = (prefix === "" ? name : `${prefix}/${name}`).replace(/\/$/, "");

    // Verify the stored checksum against a recomputation — this is what an
    // extractor does, and it is what catches a field written out of order.
    const header = bytes.slice(off, off + BLOCK);
    const stored = parseInt(field(off, 148, 8) || "-1", 8);
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of header) sum += b;
    expect(sum).toBe(stored);

    out.set(path, {
      path,
      mode: parseInt(field(off, 100, 8) || "0", 8),
      uid: parseInt(field(off, 108, 8) || "0", 8),
      gid: parseInt(field(off, 116, 8) || "0", 8),
      type: typeflag === "5" ? "directory" : "file",
      content: dec.decode(bytes.subarray(off + BLOCK, off + BLOCK + size)),
    });
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

const file = (path: string, content: string, mode = 0o400): UstarEntry => ({
  path,
  mode,
  uid: 1001,
  gid: 1001,
  content: new TextEncoder().encode(content),
  type: "file",
});

describe("buildUstar", () => {
  it("round-trips a file with its mode and ownership", () => {
    const parsed = parse(buildUstar([file("run/secrets/key", "SECRET")]));
    const entry = parsed.get("run/secrets/key")!;
    expect(entry.content).toBe("SECRET");
    expect(entry.mode).toBe(0o400);
    expect(entry.uid).toBe(1001);
    expect(entry.gid).toBe(1001);
  });

  it("marks directories with typeflag 5", () => {
    const parsed = parse(
      buildUstar([{ path: "run/secrets", mode: 0o755, uid: 1001, gid: 1001, type: "directory" }]),
    );
    expect(parsed.get("run/secrets")!.type).toBe("directory");
  });

  it("pads content to a block boundary so the next header is aligned", () => {
    // Two entries whose first content is not a multiple of 512: a missing pad
    // would leave the second header mid-block and unparseable.
    const parsed = parse(buildUstar([file("a", "x".repeat(7)), file("b", "y")]));
    expect(parsed.get("a")!.content).toBe("x".repeat(7));
    expect(parsed.get("b")!.content).toBe("y");
  });

  it("terminates with two zero blocks", () => {
    const archive = buildUstar([file("a", "x")]);
    expect(archive.slice(-BLOCK * 2).every((b) => b === 0)).toBe(true);
  });

  // Regression: nothing upstream bounds a `delivery.files` path — both
  // `isSafeDeliveryFilePath` and `isContainerPathSafeForMount` accept a
  // 109-byte path — so a writer capped at the 100-byte `name` field would fail
  // the whole integration spawn on a path `docker cp` used to carry fine.
  it("carries a path longer than the 100-byte name field via prefix", () => {
    const long =
      "home/runner/.config/appstrate-vendor-integration/credentials/service-account/google-service-account-key.json";
    expect(long.length).toBeGreaterThan(100);
    const parsed = parse(buildUstar([file(long, "LONG")]));
    expect(parsed.get(long)!.content).toBe("LONG");
    expect(parsed.get(long)!.mode).toBe(0o400);
  });

  it("throws, rather than truncating, past what USTAR can express", () => {
    const segment = "a".repeat(120);
    expect(() => buildUstar([file(`${segment}/${segment}/${segment}`, "x")])).toThrow(/ustar/);
  });
});

describe("splitUstarPath", () => {
  it("leaves a short path entirely in name", () => {
    expect(splitUstarPath("run/secrets/key")).toEqual({ name: "run/secrets/key", prefix: "" });
  });

  it("splits on a slash boundary, keeping name within 100 bytes", () => {
    const path = "a".repeat(80) + "/" + "b".repeat(80);
    const { name, prefix } = splitUstarPath(path);
    expect(`${prefix}/${name}`).toBe(path);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(100);
    expect(new TextEncoder().encode(prefix).length).toBeLessThanOrEqual(155);
  });

  it("refuses a single segment too long to split", () => {
    expect(() => splitUstarPath("x".repeat(150))).toThrow(/cannot be split/);
  });
});
