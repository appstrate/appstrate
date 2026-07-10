// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the truncateAll retry-on-deadlock helper (issue #883).
 *
 * Pure logic — no DB. The helper is exercised with injected failures shaped
 * like the real driver errors: postgres.js raises a `PostgresError` with a
 * SQLSTATE `code` property, and Drizzle wraps it in a `DrizzleQueryError`
 * whose `cause` is the driver error.
 */
import { describe, it, expect } from "bun:test";
import { isTransientLockError, withDeadlockRetry } from "../helpers/deadlock-retry.ts";

/** Error shaped like postgres.js / PGlite driver errors (SQLSTATE on `code`). */
function pgError(code: string, message = `SQLSTATE ${code}`): Error {
  const err = new Error(message);
  (err as Error & { code: string }).code = code;
  return err;
}

/** Error shaped like Drizzle's `DrizzleQueryError` — driver error on `cause`. */
function drizzleWrapped(code: string): Error {
  return new Error("Failed query: DO $$ BEGIN ... END $$", { cause: pgError(code) });
}

const NO_DELAY = () => 0;

describe("isTransientLockError", () => {
  it("detects a deadlock (40P01) on the error itself", () => {
    expect(isTransientLockError(pgError("40P01"))).toBe(true);
  });

  it("detects a serialization failure (40001)", () => {
    expect(isTransientLockError(pgError("40001"))).toBe(true);
  });

  it("detects lock_not_available (55P03)", () => {
    expect(isTransientLockError(pgError("55P03"))).toBe(true);
  });

  it("detects a deadlock wrapped in a DrizzleQueryError cause", () => {
    expect(isTransientLockError(drizzleWrapped("40P01"))).toBe(true);
  });

  it("detects a deadlock nested two causes deep", () => {
    const doubleWrapped = new Error("outer", { cause: drizzleWrapped("40P01") });
    expect(isTransientLockError(doubleWrapped)).toBe(true);
  });

  it("rejects non-retryable SQLSTATEs (unique violation, FK violation)", () => {
    expect(isTransientLockError(pgError("23505"))).toBe(false);
    expect(isTransientLockError(drizzleWrapped("23503"))).toBe(false);
  });

  it("rejects plain errors, non-string codes, and non-error values", () => {
    expect(isTransientLockError(new Error("boom"))).toBe(false);
    const numericCode = new Error("boom");
    (numericCode as Error & { code: number }).code = 40001;
    expect(isTransientLockError(numericCode)).toBe(false);
    expect(isTransientLockError("40P01")).toBe(false);
    expect(isTransientLockError(null)).toBe(false);
    expect(isTransientLockError(undefined)).toBe(false);
    expect(isTransientLockError(40)).toBe(false);
  });

  it("gives up on a cause chain deeper than the walk limit", () => {
    // 6 wrappers around the coded error — one past MAX_CAUSE_DEPTH (5).
    let err: Error = pgError("40P01");
    for (let i = 0; i < 6; i++) err = new Error(`wrap ${i}`, { cause: err });
    expect(isTransientLockError(err)).toBe(false);
  });

  it("survives a self-referencing cause cycle", () => {
    const err = new Error("cyclic");
    (err as Error & { cause: unknown }).cause = err;
    expect(isTransientLockError(err)).toBe(false);
  });
});

describe("withDeadlockRetry", () => {
  it("returns the result without retrying on success", async () => {
    let calls = 0;
    const result = await withDeadlockRetry(async () => {
      calls++;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries a deadlock and succeeds on a later attempt", async () => {
    let calls = 0;
    const result = await withDeadlockRetry(
      async () => {
        calls++;
        if (calls < 3) throw drizzleWrapped("40P01");
        return "recovered";
      },
      { delayMs: NO_DELAY },
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
  });

  it("rethrows a non-retryable error immediately", async () => {
    let calls = 0;
    const boom = pgError("23505");
    await expect(
      withDeadlockRetry(
        async () => {
          calls++;
          throw boom;
        },
        { delayMs: NO_DELAY },
      ),
    ).rejects.toBe(boom);
    expect(calls).toBe(1);
  });

  it("rethrows the last error once attempts are exhausted", async () => {
    let calls = 0;
    const errors = [
      pgError("40P01", "first"),
      pgError("40P01", "second"),
      pgError("40P01", "third"),
    ];
    await expect(
      withDeadlockRetry(
        async () => {
          throw errors[calls++];
        },
        { maxAttempts: 3, delayMs: NO_DELAY },
      ),
    ).rejects.toBe(errors[2]);
    expect(calls).toBe(3);
  });

  it("respects maxAttempts: 1 (no retry at all)", async () => {
    let calls = 0;
    await expect(
      withDeadlockRetry(
        async () => {
          calls++;
          throw pgError("40P01");
        },
        { maxAttempts: 1, delayMs: NO_DELAY },
      ),
    ).rejects.toThrow("SQLSTATE 40P01");
    expect(calls).toBe(1);
  });

  it("invokes onRetry with the error and the failed attempt number", async () => {
    const seen: Array<{ err: unknown; attempt: number }> = [];
    let calls = 0;
    await withDeadlockRetry(
      async () => {
        calls++;
        if (calls < 3) throw pgError("40P01", `failure ${calls}`);
        return "ok";
      },
      {
        delayMs: NO_DELAY,
        onRetry: (err, attempt) => seen.push({ err, attempt }),
      },
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]?.attempt).toBe(1);
    expect(seen[1]?.attempt).toBe(2);
    expect((seen[0]?.err as Error).message).toBe("failure 1");
    expect((seen[1]?.err as Error).message).toBe("failure 2");
  });

  it("does not invoke onRetry for a non-retryable error", async () => {
    let retries = 0;
    await expect(
      withDeadlockRetry(
        async () => {
          throw new Error("plain");
        },
        { delayMs: NO_DELAY, onRetry: () => retries++ },
      ),
    ).rejects.toThrow("plain");
    expect(retries).toBe(0);
  });

  it("rejects a non-positive or non-integer maxAttempts", async () => {
    await expect(withDeadlockRetry(async () => "x", { maxAttempts: 0 })).rejects.toThrow(
      RangeError,
    );
    await expect(withDeadlockRetry(async () => "x", { maxAttempts: 1.5 })).rejects.toThrow(
      RangeError,
    );
  });

  it("waits between attempts using the injected delay", async () => {
    const delays: number[] = [];
    let calls = 0;
    const start = Date.now();
    await withDeadlockRetry(
      async () => {
        calls++;
        if (calls < 2) throw pgError("40P01");
        return "ok";
      },
      {
        delayMs: (attempt) => {
          delays.push(attempt);
          return 10;
        },
      },
    );
    expect(delays).toEqual([2]); // delay computed for the 2nd attempt
    expect(Date.now() - start).toBeGreaterThanOrEqual(9);
  });
});
