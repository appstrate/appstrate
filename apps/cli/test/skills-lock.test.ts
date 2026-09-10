// SPDX-License-Identifier: Apache-2.0

/**
 * The cross-process lock `appstrate skills sync` holds for its whole body.
 *
 * Tested through the helper rather than the command: the production wait is
 * 60 seconds, and a suite that exercised it for real would take a minute to
 * say what these millisecond-scale cases say. The one property that matters
 * most — the kernel releases the lock when the holder is killed — is proven
 * with a real child process and a real SIGKILL.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeSync, openSync } from "node:fs";
import {
  getLockPath,
  resolveTryLock,
  SyncLockBusyError,
  withSyncLock,
  type LockAttempt,
} from "../src/lib/skills-sync/lock.ts";
import { createMemoryIO } from "./helpers/memory-io.ts";

const originalDataHome = process.env.XDG_DATA_HOME;
let dataHome: string;

beforeEach(async () => {
  dataHome = await mkdtemp(join(tmpdir(), "appstrate-cli-skills-lock-"));
  process.env.XDG_DATA_HOME = dataHome;
});

afterEach(async () => {
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalDataHome;
  await rm(dataHome, { recursive: true, force: true });
});

describe("withSyncLock", () => {
  it("runs the body and leaves the lock file in place, unlocked", async () => {
    expect(await withSyncLock(async () => "done")).toBe("done");
    // The file is never unlinked (see the source); a second run takes it.
    expect(await exists(getLockPath())).toBe(true);
    expect(await withSyncLock(async () => "again", { timeoutMs: 30, pollMs: 5 })).toBe("again");
  });

  it("releases the lock when the body throws", async () => {
    await expect(
      withSyncLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withSyncLock(async () => "taken", { timeoutMs: 30, pollMs: 5 })).toBe("taken");
  });

  it("serializes two overlapping runs rather than interleaving them", async () => {
    const order: string[] = [];
    // The second call is only created once the first has ENTERED its body, so
    // it is holding the lock. Starting both at once and asserting a literal
    // order is a race: each call awaits a `mkdir` before it competes, and
    // which one wins that is not ours to decide.
    let entered!: () => void;
    const holding = new Promise<void>((resolve) => (entered = resolve));

    const first = withSyncLock(
      async () => {
        order.push("first:start");
        entered();
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push("first:end");
      },
      { pollMs: 5, timeoutMs: 2000 },
    );
    await holding;

    const second = withSyncLock(
      async () => {
        order.push("second:start");
      },
      { pollMs: 5, timeoutMs: 2000 },
    );
    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("gives up with a busy error while a live holder keeps the lock", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => (entered = resolve));
    const holder = withSyncLock(async () => {
      entered();
      await held;
    });
    await entry;

    await expect(
      withSyncLock(async () => "never", { timeoutMs: 30, pollMs: 5 }),
    ).rejects.toBeInstanceOf(SyncLockBusyError);
    release();
    await holder;
  });

  it("is released by the kernel when the holder is SIGKILLed", async () => {
    // A real process holds the lock through this module, then dies the way
    // a background sync dies when its Claude Code session closes.
    const holder = Bun.spawn(
      [
        "bun",
        "-e",
        `const { withSyncLock } = await import(${JSON.stringify(
          new URL("../src/lib/skills-sync/lock.ts", import.meta.url).pathname,
        )});
         await withSyncLock(async () => { console.log("held"); await new Promise(() => {}); });`,
      ],
      { env: { ...process.env, XDG_DATA_HOME: dataHome }, stdout: "pipe" },
    );
    const reader = holder.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("held");

    await expect(
      withSyncLock(async () => "never", { timeoutMs: 30, pollMs: 5 }),
    ).rejects.toBeInstanceOf(SyncLockBusyError);

    holder.kill("SIGKILL");
    await holder.exited;
    expect(await withSyncLock(async () => "taken", { timeoutMs: 30, pollMs: 5 })).toBe("taken");
  });
});

describe("the flock binding", () => {
  it("reads errno and calls a held lock busy", async () => {
    // Two descriptors on one file: flock is per open file description, so the
    // second attempt is exactly what a competing process would see.
    await withSyncLock(async () => "seed");
    const held = openSync(getLockPath(), "a", 0o600);
    const rival = openSync(getLockPath(), "a", 0o600);
    try {
      const tryLock = resolveTryLock();
      expect(tryLock(held)).toEqual({ status: "acquired" });
      expect(tryLock(rival)).toEqual({ status: "busy" });
    } finally {
      closeSync(rival);
      closeSync(held);
    }
  });

  it("calls an errno that is not EWOULDBLOCK unsupported, not busy", () => {
    // EBADF stands in for the ENOLCK / EOPNOTSUPP an flock-less mount returns:
    // the point is that a non-EWOULDBLOCK errno must not enter the poll loop.
    const attempt = resolveTryLock()(9999);
    expect(attempt.status).toBe("unsupported");
    expect(attempt).toMatchObject({ reason: expect.stringContaining("errno") });
  });

  it("reports Windows unsupported without reaching for libc", () => {
    const attempt = resolveTryLock("win32")(1);
    expect(attempt).toEqual({ status: "unsupported", reason: "Windows has no flock(2)" });
  });
});

describe("withSyncLock without a working flock", () => {
  it("runs the body unlocked and says so on stderr", async () => {
    const { io, stderr } = createMemoryIO();
    const result = await withSyncLock(async () => "ran", {
      io,
      tryLock: () => ({ status: "unsupported", reason: "Windows has no flock(2)" }),
    });
    expect(result).toBe("ran");
    expect(stderr()).toContain("skills sync lock unavailable (Windows has no flock(2))");
    expect(stderr()).toContain("continuing unlocked");
  });

  it("never reports a competing sync that does not exist", async () => {
    // The bug: an unsupported filesystem waited out the whole timeout and then
    // named another process. Nothing here is allowed to throw or to poll.
    const { io } = createMemoryIO();
    await expect(
      withSyncLock(async () => "ran", {
        io,
        timeoutMs: 0,
        tryLock: () => ({ status: "unsupported", reason: "flock(2) failed with errno 95" }),
      }),
    ).resolves.toBe("ran");
  });

  it("retries a signal-interrupted attempt instead of polling", async () => {
    const attempts: LockAttempt[] = [
      { status: "interrupted" },
      { status: "interrupted" },
      { status: "acquired" },
    ];
    // pollMs is long enough that a wait between attempts would blow the
    // deadline; only an immediate retry gets to "acquired".
    const result = await withSyncLock(async () => "ran", {
      timeoutMs: 5_000,
      pollMs: 60_000,
      tryLock: () => attempts.shift() ?? { status: "acquired" },
    });
    expect(result).toBe("ran");
    expect(attempts).toHaveLength(0);
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
