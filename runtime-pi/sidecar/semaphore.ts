// SPDX-License-Identifier: Apache-2.0

/**
 * Tiny single-process concurrency limiter.
 *
 * Used by the sidecar to cap the number of in-flight `provider_call`
 * MCP tool invocations a single run can fan out. Without a cap, an
 * agent that fetches N items in parallel (8 Gmail messages, 20 ClickUp
 * tasks, …) can stuff the next LLM turn with hundreds of KB of JSON in
 * one shot and blow past the upstream model's TPM window. See
 * issue #427 for the reference incident.
 *
 * Bun runs the sidecar on a single-threaded event loop so we don't
 * need real mutexes — `acquire()` resolves immediately when the
 * permit budget has room, otherwise it parks the caller on a FIFO
 * waiter queue. The returned `release` is idempotent (calling it
 * twice from the same caller doesn't refund two permits) so callers
 * can safely place it in a `try { … } finally { release(); }`.
 */
export class Semaphore {
  readonly maxConcurrent: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    if (!Number.isFinite(maxConcurrent) || !Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
      throw new Error(
        `Semaphore: maxConcurrent must be a positive integer, got ${String(maxConcurrent)}.`,
      );
    }
    this.maxConcurrent = maxConcurrent;
  }

  /** Number of permits currently held. Test-only observability. */
  get inFlight(): number {
    return this.active;
  }

  /** Waiters parked because all permits are held. Test-only observability. */
  get queued(): number {
    return this.waiters.length;
  }

  /**
   * Acquire a permit. Resolves with a single-shot `release` function —
   * subsequent calls on the same handle are no-ops, so a `finally`-based
   * cleanup never accidentally over-releases.
   */
  async acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return this.makeRelease();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    return this.makeRelease();
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}

/**
 * Default cap on simultaneous `provider_call` MCP invocations per run.
 * Three matches the typical browsing concurrency a single LLM turn can
 * usefully exploit while leaving headroom under most providers' per-IP
 * rate limits. Operators can override via
 * `SIDECAR_PROVIDER_CALL_CONCURRENCY`.
 */
export const DEFAULT_PROVIDER_CALL_CONCURRENCY = 3;

/**
 * Read a positive-integer concurrency cap from an env var, falling
 * back to `defaultValue` when unset/empty. Mirrors the
 * `readPositive*Env` helpers in `helpers.ts` and `token-budget.ts`
 * so misconfiguration fails loud at sidecar boot.
 */
export function readPositiveConcurrencyEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}.`);
  }
  return parsed;
}
