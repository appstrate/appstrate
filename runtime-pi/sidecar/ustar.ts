// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal USTAR writer, used to hand `docker cp -` an archive whose entries
 * carry the ownership WE choose.
 *
 * Why this exists: `docker cp <hostdir> <container>:/` copies each file with
 * the ownership of the host-side source. The sidecar cannot chown a staged
 * file to the runner image's uid (that needs privileges it does not have, and
 * on macOS it is refused outright), so an owner-only `delivery.files` mode —
 * `0400`, the default — landed as `uid=<host user>` and the runner, which runs
 * as `USER runner:runner` (uid 1001) in all four runner images, could not read
 * its own credential.
 *
 * A tar built in-process sidesteps that entirely: uid/gid are just header
 * fields. The strict mode is preserved rather than widened, which is the point
 * — the alternative fix, relaxing `0400` to something world-readable, would
 * have traded a real permission bit for a workaround.
 *
 * Deliberately minimal: regular files and directories, no symlinks, no PAX
 * extensions. Paths use the USTAR `name` + `prefix` pair, so up to 255 bytes
 * split on a `/` boundary. Beyond that the format itself has no answer without
 * PAX, and {@link buildUstar} throws rather than truncate — nothing upstream
 * bounds a `delivery.files` path, so this limit is real and must be loud.
 * Everything this writer emits is reproducible byte-for-byte from its inputs.
 */

const BLOCK_SIZE = 512;
const NAME_FIELD = 100;
const PREFIX_FIELD = 155;

export interface UstarEntry {
  /** Archive-relative path, no leading `/`. Max 255 bytes (UTF-8, see above). */
  path: string;
  /** POSIX mode bits, e.g. 0o400. */
  mode: number;
  uid: number;
  gid: number;
  /** Omitted for directories. */
  content?: Uint8Array;
  type: "file" | "directory";
}

/** Octal field, NUL-terminated, left-padded with zeros (USTAR convention). */
function octalField(value: number, width: number): string {
  const digits = width - 1;
  const text = value.toString(8);
  if (text.length > digits) {
    throw new Error(`ustar: value ${value} does not fit in ${digits} octal digits`);
  }
  return text.padStart(digits, "0") + "\0";
}

function writeAscii(block: Uint8Array, offset: number, text: string, width: number): void {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > width) {
    throw new Error(`ustar: field overflows ${width} bytes: ${text}`);
  }
  block.set(bytes, offset);
}

/**
 * Split a path across the USTAR `prefix` + `name` fields.
 *
 * An extractor rebuilds the path as `prefix + "/" + name`, so the split must
 * fall on a `/` boundary, with at most 155 bytes before it and 100 after. We
 * take the LAST boundary that satisfies both, which keeps as much of the path
 * as possible in `prefix` and leaves `name` short.
 */
export function splitUstarPath(path: string): { name: string; prefix: string } {
  const encoder = new TextEncoder();
  if (encoder.encode(path).length <= NAME_FIELD) return { name: path, prefix: "" };

  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (
      encoder.encode(prefix).length <= PREFIX_FIELD &&
      encoder.encode(name).length <= NAME_FIELD &&
      name.length > 0
    ) {
      return { name, prefix };
    }
  }
  throw new Error(
    `ustar: path cannot be split into ${PREFIX_FIELD}-byte prefix + ${NAME_FIELD}-byte name: ${path}`,
  );
}

function buildHeader(entry: UstarEntry, size: number): Uint8Array {
  const full = entry.type === "directory" ? entry.path.replace(/\/*$/, "") + "/" : entry.path;
  const { name, prefix } = splitUstarPath(full);

  const block = new Uint8Array(BLOCK_SIZE);
  writeAscii(block, 0, name, NAME_FIELD);
  writeAscii(block, 100, octalField(entry.mode & 0o7777, 8), 8);
  writeAscii(block, 108, octalField(entry.uid, 8), 8);
  writeAscii(block, 116, octalField(entry.gid, 8), 8);
  writeAscii(block, 124, octalField(size, 12), 12);
  // mtime 0 (epoch): the archive is a transport, not a backup, and a fixed
  // timestamp keeps the bytes reproducible.
  writeAscii(block, 136, octalField(0, 12), 12);
  // Checksum is computed over a header whose own checksum field reads as
  // spaces — fill it now, sum, then overwrite.
  block.fill(0x20, 148, 156);
  writeAscii(block, 156, entry.type === "directory" ? "5" : "0", 1);
  writeAscii(block, 257, "ustar\0", 6);
  writeAscii(block, 263, "00", 2);
  // `prefix` sits AFTER the checksum field, so it must be written before the
  // checksum is summed — an extractor validates the whole 512-byte block.
  if (prefix !== "") writeAscii(block, 345, prefix, PREFIX_FIELD);

  let checksum = 0;
  for (const byte of block) checksum += byte;
  // Historical format: 6 octal digits, NUL, then a space.
  writeAscii(block, 148, checksum.toString(8).padStart(6, "0") + "\0 ", 8);

  return block;
}

/** Serialize entries into a complete USTAR archive (with the two-block EOF). */
export function buildUstar(entries: readonly UstarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const push = (chunk: Uint8Array) => {
    chunks.push(chunk);
    total += chunk.length;
  };

  for (const entry of entries) {
    const content =
      entry.type === "file" ? (entry.content ?? new Uint8Array(0)) : new Uint8Array(0);
    push(buildHeader(entry, content.length));
    if (content.length > 0) {
      push(content);
      const remainder = content.length % BLOCK_SIZE;
      if (remainder !== 0) push(new Uint8Array(BLOCK_SIZE - remainder));
    }
  }
  // Two zero blocks terminate the archive.
  push(new Uint8Array(BLOCK_SIZE * 2));

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
