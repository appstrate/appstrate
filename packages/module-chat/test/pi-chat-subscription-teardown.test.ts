// SPDX-License-Identifier: Apache-2.0

/**
 * Static teardown guard for the Pi chat engine's turn `finally`.
 *
 * `subscribe()` on a Pi `AgentSession` returns the DETACH handle. The engine
 * discarded it, and `PiChatSession` re-declared the return type as `void`, so
 * the handle was unreachable even in principle. The turn's `finally` then tore
 * down the deadline timer, the abort listener and the MCP client — and left the
 * subscription attached. A Pi event arriving after `execute` returns calls
 * `write()` on a stream writer that is already closed, which the engine's own
 * header documents as answering `TypeError: Invalid state`, thrown from a
 * callback no caller's try/catch covers.
 *
 * The abort had the same shape of bug: launched with `void` and never awaited,
 * so the producer returned — and the concurrency slot went to the next turn —
 * while the Pi session was still winding down.
 *
 * Why static: reproducing a late event needs the engine to hand out its live
 * `AgentSession`, which is built inside `execute` from the Pi SDK and has no
 * injection seam. Adding one to observe a teardown would be a bigger change
 * than the teardown. The invariant is decidable from the source — same channel
 * and cost as `apps/api/test/unit/run-admission-lock-order.test.ts`.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src", "pi-chat");

/**
 * Source with comment lines dropped — each of these files explains its teardown
 * in prose naming the very symbols asserted on, so a raw `includes` would match
 * the explanation rather than the code.
 */
function code(file: string): string {
  return readFileSync(join(SRC, file), "utf8")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

/** The body of the turn producer's `finally` block. */
function turnFinally(): string {
  const engine = code("engine.ts");
  const start = engine.lastIndexOf("} finally {");
  expect(start, "engine.ts has no turn `finally` block").toBeGreaterThan(0);
  return engine.slice(start);
}

/** `includes`, asserted without dumping the whole file into the failure. */
function expectSource(haystack: string, needle: string, why: string): void {
  expect(haystack.includes(needle), `${why} — expected to find: ${needle}`).toBe(true);
}

describe("pi chat turn teardown", () => {
  it("declares subscribe() as returning its detach handle", () => {
    expectSource(
      code("turn-control.ts"),
      "subscribe(cb: (event: unknown) => void): () => void;",
      "PiChatSession must expose the detach handle Pi returns",
    );
  });

  it("captures the subscription handle instead of discarding it", () => {
    expectSource(
      code("engine.ts"),
      "unsubscribe = typedSession.subscribe(",
      "the engine must keep the handle",
    );
  });

  it("releases the subscription in the turn's finally", () => {
    expectSource(
      turnFinally(),
      "unsubscribe?.();",
      "the subscription must be detached with the rest of the turn",
    );
  });

  it("still tears down the timer, the abort listener and the MCP client", () => {
    // Control: the three teardowns that were already correct. Passes before and
    // after — a failure here means the new one displaced an old one.
    const teardown = turnFinally();
    expectSource(teardown, "clearTimeout(deadline);", "deadline timer");
    expectSource(teardown, 'abortSignal.removeEventListener("abort", forwardAbort);', "listener");
    expectSource(teardown, "await mcpTools?.close();", "MCP client");
  });

  it("awaits the session abort before returning from the turn", () => {
    const engine = code("engine.ts");
    expectSource(engine, "await typedSession.abort?.()", "the abort must be awaited");
    // The fire-and-forget form must not come back: it releases the concurrency
    // slot while the session can still emit.
    expect(
      engine.includes("void typedSession.abort?.()"),
      "the abort must not be fire-and-forget",
    ).toBe(false);
  });
});
