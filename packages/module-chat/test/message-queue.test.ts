// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  createMessageQueue,
  firstName,
  flushDecision,
  joinQueued,
} from "../src/ui/message-queue.ts";

describe("joinQueued", () => {
  it("joins queued texts into one message, a blank line apart", () => {
    expect(joinQueued(["a", "b", "c"])).toBe("a\n\nb\n\nc");
  });
});

describe("flushDecision", () => {
  const queued = { items: ["a"], stopped: false } as const;

  it("sends when the turn ends with a queue", () => {
    expect(flushDecision({ wasRunning: true, running: false, snapshot: queued })).toBe("send");
  });

  it("holds when the user stopped the turn", () => {
    expect(
      flushDecision({
        wasRunning: true,
        running: false,
        snapshot: { items: ["a"], stopped: true },
      }),
    ).toBe("hold");
  });

  it("does nothing while running, when idle, or with an empty queue", () => {
    expect(flushDecision({ wasRunning: true, running: true, snapshot: queued })).toBe("none");
    expect(flushDecision({ wasRunning: false, running: false, snapshot: queued })).toBe("none");
    expect(
      flushDecision({
        wasRunning: true,
        running: false,
        snapshot: { items: [], stopped: true },
      }),
    ).toBe("none");
  });
});

describe("firstName", () => {
  it("takes the first whitespace-separated token", () => {
    expect(firstName("  Pierre  Cabriere ")).toBe("Pierre");
  });

  it("yields none for an absent name or an email fallback", () => {
    expect(firstName(null)).toBeNull();
    expect(firstName("   ")).toBeNull();
    expect(firstName("pierre@example.com")).toBeNull();
  });
});

describe("createMessageQueue", () => {
  it("queues trimmed texts, ignores blanks and removes by index", () => {
    const q = createMessageQueue();
    expect(q.add("  hello ")).toBe(true);
    expect(q.add("   ")).toBe(false);
    q.add("world");
    q.remove(0);
    expect(q.getSnapshot().items).toEqual(["world"]);
  });

  it("notifies subscribers and gives a new snapshot per change", () => {
    const q = createMessageQueue();
    let calls = 0;
    const off = q.subscribe(() => calls++);
    const before = q.getSnapshot();
    q.add("a");
    expect(calls).toBe(1);
    expect(q.getSnapshot()).not.toBe(before);
    off();
    q.add("b");
    expect(calls).toBe(1);
  });

  it("clear empties the queue and forgets a Stop; releaseStop keeps the items", () => {
    const q = createMessageQueue();
    q.add("a");
    q.markStopped();
    q.releaseStop();
    expect(q.getSnapshot()).toEqual({ items: ["a"], stopped: false });
    q.markStopped();
    q.clear();
    expect(q.getSnapshot()).toEqual({ items: [], stopped: false });
  });
});
