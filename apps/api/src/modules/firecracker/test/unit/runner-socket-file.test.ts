// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the daemon's socket filesystem guard (runner/socket-file.ts,
 * #868 follow-up): the root daemon must only ever delete a node that IS a
 * unix socket AND that nobody is accepting on — a misconfigured
 * FIRECRACKER_RUNNER_SOCKET pointing at a regular file must be refused
 * loudly, and a live daemon's socket must never be stolen out from under it.
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

/**
 * Bind a unix listener so a LIVE socket node exists at `path` (something
 * is accepting on it), run `fn` against it, then stop the listener. The
 * listener is kept open for the duration on purpose: whether `stop()`
 * unlinks the node varies across Bun versions.
 */
async function withSocketNode(path: string, fn: () => Promise<void>): Promise<void> {
  const listener = Bun.listen({ unix: path, socket: { data() {} } });
  try {
    await fn();
  } finally {
    listener.stop(true);
  }
}

/**
 * Leave a genuinely STALE socket node at `path`: a child process binds it,
 * then SIGKILLs itself — the kernel closes the fd but never unlinks the
 * node, exactly what a crashed daemon leaves behind. (Binding in THIS
 * process and stopping the listener won't do: some Bun versions unlink the
 * node on stop, and a clean stop is the one path that never strands one.)
 */
async function createStaleSocketNode(path: string): Promise<void> {
  const script =
    `Bun.listen({ unix: ${JSON.stringify(path)}, socket: { data() {} } });` +
    `process.kill(process.pid, "SIGKILL");`;
  const proc = Bun.spawn([process.execPath, "-e", script], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
  expect(existsSync(path)).toBe(true);
}

describe("removeStaleSocket", () => {
  it("is a no-op when nothing exists at the path", async () => {
    await expect(removeStaleSocket(join(dir, "missing.sock"))).resolves.toBeUndefined();
  });

  it("unlinks a stale socket node (crashed predecessor) so a fresh bind can succeed", async () => {
    const path = join(dir, "stale.sock");
    await createStaleSocketNode(path);
    await removeStaleSocket(path);
    expect(existsSync(path)).toBe(false);
  });

  it("REFUSES to unlink a socket a live process is accepting on", async () => {
    const path = join(dir, "live.sock");
    await withSocketNode(path, async () => {
      await expect(removeStaleSocket(path)).rejects.toThrow(/accepting connections/);
      expect(existsSync(path)).toBe(true);
    });
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
    await withSocketNode(path, async () => {
      await unlinkSocketIfPresent(path);
      expect(existsSync(path)).toBe(false);
    });
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
