// SPDX-License-Identifier: Apache-2.0

export interface UnexpectedSidecarExit {
  runId: string;
  containerId: string;
  exitCode: number;
  tail?: string;
}

export interface SidecarExitWatcherError {
  runId: string;
  containerId: string;
  error: unknown;
}

export interface SidecarExitWatcherDependencies {
  waitForExit(containerId: string): Promise<number>;
  streamLogs(containerId: string, signal: AbortSignal): AsyncIterable<string>;
  onUnexpectedExit(exit: UnexpectedSidecarExit): void;
  onWatcherError(error: SidecarExitWatcherError): void;
}

/**
 * Correlates the sidecar exit watcher with lifecycle teardown calls.
 *
 * The expectation is installed before stop/remove starts and is consumed by
 * the watcher only after Docker reports the exit. Keeping that state across
 * the teardown await closes the race where remove succeeds just before the
 * watcher resumes and would otherwise report a normal cleanup as a crash.
 */
export class SidecarExitWatcher {
  private readonly expectedExits = new Set<string>();
  private readonly watchedContainers = new Set<string>();

  constructor(private readonly dependencies: SidecarExitWatcherDependencies) {}

  async watch(runId: string, containerId: string): Promise<void> {
    this.watchedContainers.add(containerId);
    try {
      const exitCode = await this.dependencies.waitForExit(containerId);
      if (this.expectedExits.delete(containerId)) return;

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
      this.dependencies.onWatcherError({ runId, containerId, error });
    } finally {
      this.watchedContainers.delete(containerId);
      this.expectedExits.delete(containerId);
    }
  }

  async expectExitDuring(containerId: string, teardown: () => Promise<void>): Promise<void> {
    this.expectedExits.add(containerId);
    try {
      await teardown();
    } catch (error) {
      // The teardown did not complete, so a later exit must not inherit a
      // stale expectation from the failed attempt.
      this.expectedExits.delete(containerId);
      throw error;
    }

    // If the watcher already completed (or never started), nobody remains to
    // consume this marker. Otherwise retain it until waitForExit resolves.
    if (!this.watchedContainers.has(containerId)) {
      this.expectedExits.delete(containerId);
    }
  }

  clearExpectedExits(): void {
    this.expectedExits.clear();
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
