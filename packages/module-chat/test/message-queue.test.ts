// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  canQueueDraft,
  createMessageQueue,
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

describe("canQueueDraft", () => {
  const draft = {
    running: true,
    text: "more",
    hasAttachments: false,
    queued: [] as string[],
    pinned: [] as string[],
  };

  it("queues the text typed while a turn runs", () => {
    expect(canQueueDraft(draft)).toBe(true);
  });

  it("does not queue a draft that names an agent: no launch waits in a queue", () => {
    expect(canQueueDraft({ ...draft, text: ":agent[Report]{name=run-report} for Q3" })).toBe(false);
  });

  it("refuses a draft whose skills, with the queued ones, would pass the pin cap", () => {
    const sk = (n: string) => `:skill[${n}]{name=@acme/${n}}`;
    const pinned = ["@acme/a", "@acme/b", "@acme/c"];
    const queued = [sk("d")];
    expect(canQueueDraft({ ...draft, pinned, queued, text: sk("e") })).toBe(true);
    expect(canQueueDraft({ ...draft, pinned, queued, text: `${sk("e")} ${sk("f")}` })).toBe(false);
    // A skill already pinned or queued takes no room.
    expect(canQueueDraft({ ...draft, pinned, queued, text: `${sk("a")} ${sk("d")}` })).toBe(true);
  });

  it("queues a draft that names a skill: it is pinned when the queue is sent", () => {
    expect(canQueueDraft({ ...draft, text: "use :skill[tone]{name=@acme/tone}" })).toBe(true);
  });

  it("does not queue blank text, files, or outside a running turn", () => {
    expect(canQueueDraft({ ...draft, text: "  " })).toBe(false);
    expect(canQueueDraft({ ...draft, hasAttachments: true })).toBe(false);
    expect(canQueueDraft({ ...draft, running: false })).toBe(false);
  });
});
