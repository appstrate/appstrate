// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  SidecarExitWatcher,
  type UnexpectedSidecarExit,
} from "../../../src/services/orchestrator/sidecar-exit-watcher.ts";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // The watcher owns every rejection; without this the unconsumed promise
  // would trip bun's unhandled-rejection reporter before `watch` attaches.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function createWatcher(
  exit: Promise<number>,
  unexpected: UnexpectedSidecarExit[],
  watcherErrors: unknown[] = [],
) {
  return new SidecarExitWatcher({
    waitForExit: () => exit,
    streamLogs: async function* () {
      yield "last sidecar line";
    },
    onUnexpectedExit: (event) => unexpected.push(event),
    onWatcherError: (error) => watcherErrors.push(error),
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

  it("suppresses an expected exit observed as a rejection, not an exit code", async () => {
    // Teardown force-removes the sidecar, so the in-flight waitForExit can
    // lose the container mid-poll and reject instead of returning. A removal
    // WE asked for must not surface as a watcher error just because of how
    // it was observed (#1130).
    const exit = deferred<number>();
    const unexpected: UnexpectedSidecarExit[] = [];
    const watcherErrors: unknown[] = [];
    const watcher = createWatcher(exit.promise, unexpected, watcherErrors);
    const watching = watcher.watch("run-vanish", "sidecar-vanish");

    await watcher.expectExitDuring("sidecar-vanish", async () => {});
    exit.reject(new Error("container disappeared"));
    await watching;

    expect(unexpected).toEqual([]);
    expect(watcherErrors).toEqual([]);
  });

  it("still reports a rejection nobody asked for", async () => {
    // The other half: without an expectation, a disappearance is real news.
    const exit = deferred<number>();
    const unexpected: UnexpectedSidecarExit[] = [];
    const watcherErrors: unknown[] = [];
    const watcher = createWatcher(exit.promise, unexpected, watcherErrors);
    const watching = watcher.watch("run-surprise", "sidecar-surprise");

    exit.reject(new Error("container disappeared"));
    await watching;

    expect(watcherErrors).toHaveLength(1);
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
