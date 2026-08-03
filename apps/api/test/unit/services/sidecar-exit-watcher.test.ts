// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  SidecarExitWatcher,
  type UnexpectedSidecarExit,
} from "../../../src/services/orchestrator/sidecar-exit-watcher.ts";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createWatcher(exit: Promise<number>, unexpected: UnexpectedSidecarExit[]) {
  return new SidecarExitWatcher({
    waitForExit: () => exit,
    streamLogs: async function* () {
      yield "last sidecar line";
    },
    onUnexpectedExit: (event) => unexpected.push(event),
    onWatcherError: () => {},
  });
}

describe("SidecarExitWatcher", () => {
  it("suppresses an expected exit that resolves after removal completes", async () => {
    const exit = deferred<number>();
    const unexpected: UnexpectedSidecarExit[] = [];
    const watcher = createWatcher(exit.promise, unexpected);
    const watching = watcher.watch("run-1", "sidecar-1");

    await watcher.expectExitDuring("sidecar-1", async () => {});
    exit.resolve(137);
    await watching;

    expect(unexpected).toEqual([]);
  });

  it("suppresses an expected exit for a bulk run stop", async () => {
    const exit = deferred<number>();
    const unexpected: UnexpectedSidecarExit[] = [];
    const watcher = createWatcher(exit.promise, unexpected);
    const watching = watcher.watch("run-bulk", "sidecar-bulk");

    const result = await watcher.expectRunExitDuring("run-bulk", async () => "stopped" as const);
    exit.resolve(137);
    await watching;

    expect(result).toBe("stopped");
    expect(unexpected).toEqual([]);
  });

  it("reports an unexpected non-zero exit with its log tail", async () => {
    const unexpected: UnexpectedSidecarExit[] = [];
    const watcher = createWatcher(Promise.resolve(1), unexpected);

    await watcher.watch("run-2", "sidecar-2");

    expect(unexpected).toEqual([
      {
        runId: "run-2",
        containerId: "sidecar-2",
        exitCode: 1,
        tail: "last sidecar line",
      },
    ]);
  });

  it("rolls back the expectation when teardown fails", async () => {
    const exit = deferred<number>();
    const unexpected: UnexpectedSidecarExit[] = [];
    const watcher = createWatcher(exit.promise, unexpected);
    const watching = watcher.watch("run-3", "sidecar-3");

    await expect(
      watcher.expectExitDuring("sidecar-3", async () => {
        throw new Error("remove failed");
      }),
    ).rejects.toThrow("remove failed");
    exit.resolve(1);
    await watching;

    expect(unexpected).toHaveLength(1);
  });
});
