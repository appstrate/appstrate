// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the daemon's socket filesystem guard (runner/socket-file.ts,
 * #868 follow-up): the root daemon must only ever delete a node that IS a
 * unix socket — a misconfigured FIRECRACKER_RUNNER_SOCKET pointing at a
 * regular file (or anything else) must be refused loudly, never unlinked.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeStaleSocket, unlinkSocketIfPresent } from "../../runner/socket-file.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "appstrate-socket-file-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Bind + immediately stop a unix listener — Bun leaves the node behind,
 *  which is exactly the crashed-daemon stale-socket scenario. */
function createStaleSocket(path: string): void {
  const listener = Bun.listen({ unix: path, socket: { data() {} } });
  listener.stop(true);
}

describe("removeStaleSocket", () => {
  it("is a no-op when nothing exists at the path", async () => {
    await expect(removeStaleSocket(join(dir, "missing.sock"))).resolves.toBeUndefined();
  });

  it("unlinks a stale socket node so a fresh bind can succeed", async () => {
    const path = join(dir, "stale.sock");
    createStaleSocket(path);
    expect(existsSync(path)).toBe(true);
    await removeStaleSocket(path);
    expect(existsSync(path)).toBe(false);
  });

  it("REFUSES to delete a regular file (misconfigured env) and leaves it intact", async () => {
    const path = join(dir, "important.conf");
    await writeFile(path, "precious operator data\n");
    await expect(removeStaleSocket(path)).rejects.toThrow(/NOT a unix socket/);
    expect(existsSync(path)).toBe(true);
  });

  it("REFUSES to delete a directory and leaves it intact", async () => {
    const path = join(dir, "a-directory");
    await mkdir(path);
    await expect(removeStaleSocket(path)).rejects.toThrow(/NOT a unix socket/);
    expect(existsSync(path)).toBe(true);
  });
});

describe("unlinkSocketIfPresent", () => {
  it("removes a socket node", async () => {
    const path = join(dir, "shutdown.sock");
    createStaleSocket(path);
    await unlinkSocketIfPresent(path);
    expect(existsSync(path)).toBe(false);
  });

  it("leaves a non-socket node alone and never throws", async () => {
    const path = join(dir, "not-a-socket.txt");
    await writeFile(path, "keep me\n");
    await expect(unlinkSocketIfPresent(path)).resolves.toBeUndefined();
    expect(existsSync(path)).toBe(true);
  });

  it("never throws on a missing path", async () => {
    await expect(unlinkSocketIfPresent(join(dir, "gone.sock"))).resolves.toBeUndefined();
  });
});
