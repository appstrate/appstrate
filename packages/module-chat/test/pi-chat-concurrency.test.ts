// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded concurrency for the in-process Pi chat engine: the
 * counting gate (cap via CHAT_PI_MAX_CONCURRENCY, default 6), the 429 capacity
 * response, and the slot-release stream wrapper. The wrapper is the leak guard
 * — it must fire exactly once on every terminal path: normal completion,
 * downstream cancellation (client disconnected while the persistence drain
 * also stopped), and source error.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  acquirePiChatSlot,
  chatCapacityResponse,
  piChatConcurrencyStats,
  piChatMaxConcurrency,
  warnIfDefaultChatConcurrency,
  releaseOnClose,
  resetPiChatConcurrencyStats,
  type PiChatSlot,
} from "../src/pi-chat/concurrency.ts";
import { _resetChatEnvForTests } from "../src/env.ts";

const ENV_VAR = "CHAT_PI_MAX_CONCURRENCY";

/** Set (or clear) the cap; the module env is parsed once, so drop its cache. */
function setCap(value: string | undefined): void {
  if (value === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = value;
  _resetChatEnvForTests();
}

/** Acquire every remaining slot so the gate is saturated; return them for release. */
function drainAllSlots(): PiChatSlot[] {
  const slots: PiChatSlot[] = [];
  for (;;) {
    const slot = acquirePiChatSlot();
    if (!slot) return slots;
    slots.push(slot);
  }
}

describe("piChatMaxConcurrency", () => {
  afterEach(() => {
    setCap(undefined);
  });

  it("defaults to 6 while cloud capacity remains unvalidated", () => {
    setCap(undefined);
    expect(piChatMaxConcurrency()).toBe(6);
  });

  it("reads a positive integer from the env var", () => {
    setCap("2");
    expect(piChatMaxConcurrency()).toBe(2);
  });

  it("treats an empty value as unset", () => {
    setCap("");
    expect(piChatMaxConcurrency()).toBe(6);
  });

  for (const invalid of ["0", "-3", "abc", "2.5"]) {
    it(`fails on invalid input ${JSON.stringify(invalid)} instead of falling back`, () => {
      setCap(invalid);
      expect(() => piChatMaxConcurrency()).toThrow(/CHAT_PI_MAX_CONCURRENCY/);
    });
  }
});

describe("acquirePiChatSlot", () => {
  afterEach(() => {
    setCap(undefined);
  });

  it("returns null once the cap is reached, and frees on release", () => {
    setCap("1");
    const slots = drainAllSlots();
    expect(slots.length).toBeGreaterThanOrEqual(1);
    expect(acquirePiChatSlot()).toBeNull();

    slots[0]!.release();
    const reacquired = acquirePiChatSlot();
    expect(reacquired).not.toBeNull();
    reacquired!.release();
    for (const slot of slots.slice(1)) slot.release();
  });

  it("release is idempotent — double release never over-frees the gate", () => {
    setCap("1");
    const slots = drainAllSlots();
    const slot = slots[0]!;
    slot.release();
    slot.release();
    // Only ONE slot may be re-acquirable; a second acquire must still hit the cap.
    const a = acquirePiChatSlot();
    expect(a).not.toBeNull();
    expect(acquirePiChatSlot()).toBeNull();
    a!.release();
    for (const s of slots.slice(1)) s.release();
  });
});

describe("chatCapacityResponse", () => {
  it("returns an RFC 9457 429 with retry-after", async () => {
    const res = chatCapacityResponse();
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get("retry-after")).toBe("5");
    const body = (await res.json()) as { code: string; retry_after: number };
    expect(body.code).toBe("chat_capacity");
    expect(body.retry_after).toBe(5);
  });
});

describe("releaseOnClose", () => {
  it("passes chunks through and fires onClose once on normal completion", async () => {
    let closed = 0;
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("a");
        controller.enqueue("b");
        controller.close();
      },
    });
    const out: string[] = [];
    const reader = releaseOnClose<string>(source, () => closed++).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
    expect(out).toEqual(["a", "b"]);
    expect(closed).toBe(1);
  });

  it("fires onClose when the downstream reader cancels mid-stream", async () => {
    let closed = 0;
    const source = new ReadableStream<string>({
      pull(controller) {
        controller.enqueue("chunk");
      },
    });
    const reader = releaseOnClose<string>(source, () => closed++).getReader();
    await reader.read();
    await reader.cancel("client disconnected");
    expect(closed).toBe(1);
  });

  it("fires onClose when the source errors mid-stream", async () => {
    let closed = 0;
    const source = new ReadableStream<string>({
      start(controller) {
        controller.error(new Error("upstream exploded"));
      },
    });
    const reader = releaseOnClose<string>(source, () => closed++).getReader();
    await expect(reader.read()).rejects.toThrow("upstream exploded");
    expect(closed).toBe(1);
  });

  it("swallows an onClose that throws (never breaks the stream teardown)", async () => {
    const source = new ReadableStream<string>({
      start(controller) {
        controller.close();
      },
    });
    const reader = releaseOnClose<string>(source, () => {
      throw new Error("release exploded");
    }).getReader();
    const { done } = await reader.read();
    expect(done).toBe(true);
  });
});

describe("capacity signal for sizing the cap", () => {
  afterEach(() => {
    setCap(undefined);
    resetPiChatConcurrencyStats();
  });

  it("records the high-water mark, so a quiet process reads differently from a pinned one", () => {
    setCap("3");
    resetPiChatConcurrencyStats();
    const a = acquirePiChatSlot()!;
    const b = acquirePiChatSlot()!;
    expect(piChatConcurrencyStats()).toMatchObject({ active: 2, highWaterMark: 2, max: 3 });

    // Releasing lowers `active` but must NOT lower the mark — the peak is the
    // whole point: an operator sizing the cap needs what the process ever held,
    // not what it happens to hold when they look.
    a.release();
    b.release();
    expect(piChatConcurrencyStats()).toMatchObject({ active: 0, highWaterMark: 2 });
  });

  it("counts every refusal", () => {
    setCap("1");
    resetPiChatConcurrencyStats();
    const held = acquirePiChatSlot()!;
    expect(acquirePiChatSlot()).toBeNull();
    expect(acquirePiChatSlot()).toBeNull();
    expect(piChatConcurrencyStats()).toMatchObject({ rejected: 2, active: 1, max: 1 });
    held.release();
  });

  it("warns only when the operator set no cap — the default value, chosen, is a decision", () => {
    setCap(undefined);
    expect(warnIfDefaultChatConcurrency()).toBe(true);
    setCap("6");
    expect(warnIfDefaultChatConcurrency()).toBe(false);
    setCap("32");
    expect(piChatMaxConcurrency()).toBe(32);
    expect(warnIfDefaultChatConcurrency()).toBe(false);
  });
});
