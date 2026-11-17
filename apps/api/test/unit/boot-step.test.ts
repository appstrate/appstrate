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
    expect(await bootStep("critical", "demo", async () => 42, log)).toBe(42);
    expect(calls).toHaveLength(1);
    const [message, fields] = calls[0]!;
    expect(message).toBe("Boot step");
    expect(fields).toMatchObject({ phase: "critical", step: "demo", outcome: "ok" });
    expect(fields.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("rethrows the same error, synchronous throw included, and logs failed once", async () => {
    const { calls, log } = sink();
    const boom = new Error("boom");
    const step = bootStep(
      "serving",
      "bad",
      () => {
        throw boom;
      },
      log,
    );
    await expect(step).rejects.toBe(boom);
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({ phase: "serving", step: "bad", outcome: "failed" });
  });
});
