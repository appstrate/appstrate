// SPDX-License-Identifier: Apache-2.0

/**
 * The cross-process lock `appstrate skills sync` holds for its whole body.
 *
 * Tested through the helper rather than the command: the production timings
 * are a 60-second wait and a 10-minute staleness window, and a suite that
 * exercised them for real would take eleven minutes to say what four
 * millisecond-scale cases say here. The command wires the defaults; these
 * cases pin the behaviour those defaults select.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getLockPath, SyncLockBusyError, withSyncLock } from "../src/lib/skills-sync/lock.ts";

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
  it("runs the body and releases the lock", async () => {
    const result = await withSyncLock(async () => "done");
    expect(result).toBe("done");
    expect(await exists(getLockPath())).toBe(false);
  });

  it("releases the lock when the body throws", async () => {
    await expect(
      withSyncLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await exists(getLockPath())).toBe(false);
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

  it("gives up with a busy error when the holder never lets go", async () => {
    await mkdir(join(dataHome, "appstrate", "skills-sync"), { recursive: true });
    await mkdir(getLockPath());

    await expect(
      withSyncLock(async () => "never", { timeoutMs: 30, pollMs: 5 }),
    ).rejects.toBeInstanceOf(SyncLockBusyError);
    // The foreign lock is left exactly where it was.
    expect(await exists(getLockPath())).toBe(true);
  });

  it("reaps a lock old enough to prove its owner is gone", async () => {
    await mkdir(join(dataHome, "appstrate", "skills-sync"), { recursive: true });
    await mkdir(getLockPath());
    const longAgo = new Date(Date.now() - 60 * 60_000);
    await utimes(getLockPath(), longAgo, longAgo);

    // Same short timeout as the busy case above: without the staleness rule
    // this call would fail the same way, so the assertion discriminates.
    expect(await withSyncLock(async () => "taken", { timeoutMs: 30, pollMs: 5 })).toBe("taken");
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
