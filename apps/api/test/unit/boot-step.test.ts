// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { bootStep, type BootStepLogger } from "../../src/lib/boot-step.ts";

function sink() {
  const calls: Parameters<BootStepLogger>[] = [];
  const log: BootStepLogger = (message, fields) => {
    calls.push([message, fields]);
  };
  return { calls, log };
}

describe("bootStep", () => {
  it("resolves with the value and logs one ok line", async () => {
    const { calls, log } = sink();
    const result = await bootStep("critical", "demo", async () => 42, log);
    expect(result).toBe(42);
    expect(calls).toHaveLength(1);
    const [message, fields] = calls[0]!;
    expect(message).toBe("Boot step");
    expect(fields.phase).toBe("critical");
    expect(fields.step).toBe("demo");
    expect(fields.outcome).toBe("ok");
    expect(typeof fields.durationMs).toBe("number");
    expect(fields.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("accepts a synchronous function", async () => {
    const { calls, log } = sink();
    expect(await bootStep("serving", "sync", () => "x", log)).toBe("x");
    expect(calls).toHaveLength(1);
    expect(calls[0]![1].phase).toBe("serving");
  });

  it("rethrows the same error object and logs failed once", async () => {
    const { calls, log } = sink();
    const boom = new Error("boom");
    let caught: unknown;
    try {
      await bootStep(
        "critical",
        "bad",
        async () => {
          throw boom;
        },
        log,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
    expect(calls).toHaveLength(1);
    expect(calls[0]![1].outcome).toBe("failed");
    expect(calls[0]![1].step).toBe("bad");
  });

  it("rethrows a synchronous throw unchanged", async () => {
    const { calls, log } = sink();
    const boom = new Error("sync boom");
    const p = bootStep(
      "critical",
      "sync-bad",
      () => {
        throw boom;
      },
      log,
    );
    await expect(p).rejects.toBe(boom);
    expect(calls).toHaveLength(1);
    expect(calls[0]![1].outcome).toBe("failed");
  });
});
