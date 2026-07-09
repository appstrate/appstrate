// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded concurrency for the in-process Pi subscription chat engine: the
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
  piChatMaxConcurrency,
  releaseOnClose,
  type PiChatSlot,
} from "../src/pi-chat/concurrency.ts";

const ENV_VAR = "CHAT_PI_MAX_CONCURRENCY";

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
    delete process.env[ENV_VAR];
  });

  it("defaults to 6 when the env var is absent", () => {
    delete process.env[ENV_VAR];
    expect(piChatMaxConcurrency()).toBe(6);
  });

  it("reads a positive integer from the env var", () => {
    process.env[ENV_VAR] = "2";
    expect(piChatMaxConcurrency()).toBe(2);
  });

  for (const invalid of ["0", "-3", "abc", ""]) {
    it(`falls back to the default on invalid input ${JSON.stringify(invalid)}`, () => {
      process.env[ENV_VAR] = invalid;
      expect(piChatMaxConcurrency()).toBe(6);
    });
  }
});

describe("acquirePiChatSlot", () => {
  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it("returns null once the cap is reached, and frees on release", () => {
    process.env[ENV_VAR] = "1";
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
    process.env[ENV_VAR] = "1";
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
