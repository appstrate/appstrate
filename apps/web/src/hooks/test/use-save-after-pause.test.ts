// SPDX-License-Identifier: Apache-2.0

/**
 * The timer behind every self-saving settings form. `useSaveAfterPause` calls
 * `sync` on each commit and `flush` on unmount and `pagehide`; these drive the
 * same calls by hand, the way the hook makes them.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { createPauseSaver } from "../use-save-after-pause.ts";

const DELAY = 650;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

function recorder() {
  const saved: string[] = [];
  let doneCount = 0;
  return {
    saved,
    done: () => doneCount++,
    doneCount: () => doneCount,
    // A fresh lambda each call, as a component builds one per render.
    save: () => (value: string) => saved.push(value),
  };
}

describe("createPauseSaver", () => {
  it("saves once, a pause after the last change", () => {
    const r = recorder();
    const saver = createPauseSaver<string>(DELAY);
    saver.sync("a", true, r.save(), r.done);
    jest.advanceTimersByTime(400);
    saver.sync("ab", true, r.save(), r.done);
    jest.advanceTimersByTime(400);
    expect(r.saved).toEqual([]);
    jest.advanceTimersByTime(DELAY);
    expect(r.saved).toEqual(["ab"]);
    expect(r.doneCount()).toBe(1);
  });

  it("does not re-arm on a render that changed only the callbacks", () => {
    const r = recorder();
    const saver = createPauseSaver<string>(DELAY);
    saver.sync("a", true, r.save(), r.done);
    jest.advanceTimersByTime(400);
    // An unrelated re-render: same value, new `save`/`done` lambdas.
    saver.sync("a", true, r.save(), () => r.done());
    jest.advanceTimersByTime(DELAY - 400);
    expect(r.saved).toEqual(["a"]);
  });

  it("sends the pending save at once on flush (unmount, pagehide), and only once", () => {
    const r = recorder();
    const saver = createPauseSaver<string>(DELAY);
    saver.sync("last edit", true, r.save(), r.done);
    jest.advanceTimersByTime(100);
    saver.flush();
    expect(r.saved).toEqual(["last edit"]);
    jest.advanceTimersByTime(DELAY * 2);
    saver.flush();
    expect(r.saved).toEqual(["last edit"]);
  });

  it("has nothing to flush when nothing was edited, or once the edit was dropped", () => {
    const r = recorder();
    const saver = createPauseSaver<string>(DELAY);
    saver.sync("a", false, r.save(), r.done);
    saver.flush();
    saver.sync("b", true, r.save(), r.done);
    saver.sync("b", false, r.save(), r.done);
    saver.flush();
    jest.advanceTimersByTime(DELAY);
    expect(r.saved).toEqual([]);
  });
});
