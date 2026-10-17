// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { createLatestWriter } from "../latest-write.ts";

/** A write the test settles by hand. */
function controlled(log: string[], label: string) {
  let settle!: (ok: boolean) => void;
  const done = new Promise<void>((resolve, reject) => {
    settle = (ok) => (ok ? resolve() : reject(new Error("refused")));
  });
  return {
    run: () => {
      log.push(label);
      return done;
    },
    settle,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createLatestWriter", () => {
  it("sends the first write at once", () => {
    const log: string[] = [];
    const write = createLatestWriter();
    write("color", "blue", controlled(log, "blue").run);
    expect(log).toEqual(["blue"]);
  });

  it("holds only the newest value while a write is in flight", async () => {
    const log: string[] = [];
    const write = createLatestWriter();
    const blue = controlled(log, "blue");
    write("color", "blue", blue.run);
    write("color", "rose", controlled(log, "rose").run);
    const amber = controlled(log, "amber");
    write("color", "amber", amber.run);
    expect(log).toEqual(["blue"]);
    blue.settle(true);
    await tick();
    expect(log).toEqual(["blue", "amber"]);
    amber.settle(true);
    await tick();
    expect(log).toEqual(["blue", "amber"]);
  });

  it("skips a held value equal to the one just sent", async () => {
    const log: string[] = [];
    const write = createLatestWriter();
    const blue = controlled(log, "blue");
    write("color", "blue", blue.run);
    write("color", "rose", controlled(log, "rose").run);
    write("color", "blue", controlled(log, "blue again").run);
    blue.settle(true);
    await tick();
    expect(log).toEqual(["blue"]);
  });

  it("sends the held value of each key in turn", async () => {
    const log: string[] = [];
    const write = createLatestWriter();
    const first = controlled(log, "icon a");
    write("icon", "a", first.run);
    const color = controlled(log, "color blue");
    write("color", "blue", color.run);
    write("icon", "b", controlled(log, "icon b").run);
    first.settle(true);
    await tick();
    expect(log).toEqual(["icon a", "color blue"]);
    color.settle(true);
    await tick();
    expect(log).toEqual(["icon a", "color blue", "icon b"]);
  });

  it("goes on after a refused write, and resends its value when picked again", async () => {
    const log: string[] = [];
    const write = createLatestWriter();
    const blue = controlled(log, "blue");
    write("color", "blue", blue.run);
    write("color", "blue", controlled(log, "blue again").run);
    blue.settle(false);
    await tick();
    expect(log).toEqual(["blue", "blue again"]);
  });

  it("accepts a write once the queue is drained", async () => {
    const log: string[] = [];
    const write = createLatestWriter();
    const blue = controlled(log, "blue");
    write("color", "blue", blue.run);
    blue.settle(true);
    await tick();
    write("color", "rose", controlled(log, "rose").run);
    expect(log).toEqual(["blue", "rose"]);
  });
});
