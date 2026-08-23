// SPDX-License-Identifier: Apache-2.0

export interface UnexpectedSidecarExit {
  runId: string;
  containerId: string;
  exitCode: number;
  tail?: string;
}

interface SidecarExitWatcherError {
  runId: string;
  containerId: string;
  error: unknown;
}

interface SidecarExitWatcherDependencies {
  waitForExit(containerId: string): Promise<number>;
  streamLogs(containerId: string, signal: AbortSignal): AsyncIterable<string>;
  onUnexpectedExit(exit: UnexpectedSidecarExit): void;
  onWatcherError(error: SidecarExitWatcherError): void;
}

/**
 * Correlates the sidecar exit watcher with lifecycle teardown calls.
 *
 * An expectation can target one container or every sidecar in a run. It is
 * installed before stop/remove starts and consumed only after Docker reports
 * the exit. Keeping that state across the teardown await closes the race where
 * cleanup succeeds just before the watcher resumes and would otherwise report
 * a normal cleanup as a crash.
 */
export class SidecarExitWatcher {
  private readonly expectedExits = new Set<string>();
  private readonly expectedRunExits = new Set<string>();
  private readonly watchedContainers = new Set<string>();
  private readonly watchedRuns = new Set<string>();

  constructor(private readonly dependencies: SidecarExitWatcherDependencies) {}

  async watch(runId: string, containerId: string): Promise<void> {
    this.watchedContainers.add(containerId);
    this.watchedRuns.add(runId);
    try {
      const exitCode = await this.dependencies.waitForExit(containerId);
      if (this.consumeExpectation(runId, containerId)) return;

      if (exitCode !== 0) {
        const tail = await this.readLogTail(containerId);
        this.dependencies.onUnexpectedExit({
          runId,
          containerId,
          exitCode,
          ...(tail ? { tail } : {}),
        });
      }
    } catch (error) {
      // The expectation is consumed on this path too. Teardown force-removes
      // the sidecar, so `waitForExit` can lose the container mid-poll and
      // reject rather than return — a removal WE asked for must not surface
      // as a watcher error just because it was observed as a disappearance
      // instead of an exit code.
      if (this.consumeExpectation(runId, containerId)) return;
      this.dependencies.onWatcherError({ runId, containerId, error });
    } finally {
      this.watchedContainers.delete(containerId);
      this.watchedRuns.delete(runId);
      this.expectedExits.delete(containerId);
      this.expectedRunExits.delete(runId);
    }
  }

  /**
   * Consume any pending teardown expectation for this exit, container-scoped
   * or run-scoped. Both are deleted unconditionally so a single exit cannot
   * leave a stale marker behind for a later, genuinely unexpected one.
   */
  private consumeExpectation(runId: string, containerId: string): boolean {
    const expectedContainerExit = this.expectedExits.delete(containerId);
    const expectedRunExit = this.expectedRunExits.delete(runId);
    return expectedContainerExit || expectedRunExit;
  }

  expectExitDuring<T>(containerId: string, teardown: () => Promise<T>): Promise<T> {
    return this.expectDuring(
      containerId,
      this.expectedExits,
      () => this.watchedContainers.has(containerId),
      teardown,
    );
  }

  expectRunExitDuring<T>(runId: string, teardown: () => Promise<T>): Promise<T> {
    return this.expectDuring(
      runId,
      this.expectedRunExits,
      () => this.watchedRuns.has(runId),
      teardown,
    );
  }

  clearExpectedExits(): void {
    this.expectedExits.clear();
    this.expectedRunExits.clear();
  }

  private async expectDuring<T>(
    key: string,
    expected: Set<string>,
    isWatched: () => boolean,
    teardown: () => Promise<T>,
  ): Promise<T> {
    expected.add(key);
    let result: T;
    try {
      result = await teardown();
    } catch (error) {
      // The teardown did not complete, so a later exit must not inherit a
      // stale expectation from the failed attempt.
      expected.delete(key);
      throw error;
    }

    // If the watcher already completed (or never started), nobody remains to
    // consume this marker. Otherwise retain it until waitForExit resolves.
    if (!isWatched()) expected.delete(key);
    return result;
  }

  private async readLogTail(containerId: string): Promise<string> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 2_000);
    const lines: string[] = [];
    try {
      for await (const line of this.dependencies.streamLogs(containerId, abort.signal)) {
        lines.push(line);
        if (lines.length >= 30) break;
      }
    } catch {
      // Diagnostics are best-effort and must not mask the exit itself.
    } finally {
      clearTimeout(timer);
    }
    return lines.slice(-30).join("\n");
  }
}
