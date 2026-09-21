// SPDX-License-Identifier: Apache-2.0

/**
 * A success settles only once the card's popup is closed: an SSH connection
 * exists while that popup still shows the install block.
 */

import { describe, it, expect } from "bun:test";
import {
  createConnectWaiter,
  routeCompletion,
  type Every,
  type PopupHandle,
} from "../src/ui/connect-waiter.ts";

/** A popup whose `closed` the test flips. */
function fakePopup(): PopupHandle & { close(): void } {
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    close() {
      closed = true;
    },
  };
}

/** A scheduler the test ticks by hand. */
function manualEvery() {
  const jobs = new Set<() => void>();
  const every: Every = (fn) => {
    jobs.add(fn);
    return () => jobs.delete(fn);
  };
  return { every, tick: () => [...jobs].forEach((fn) => fn()), pending: () => jobs.size };
}

function setup() {
  const clock = manualEvery();
  const calls = { count: 0 };
  const waiter = createConnectWaiter(clock.every);
  waiter.bind(() => calls.count++);
  return { waiter, calls, clock };
}

describe("createConnectWaiter", () => {
  it("does not settle a success while the popup is still open", () => {
    const { waiter, calls, clock } = setup();
    waiter.popupOpened(fakePopup());
    waiter.connected();
    clock.tick();
    clock.tick();
    expect(calls.count).toBe(0);
  });

  it("settles once when the popup closes, then stops polling", () => {
    const { waiter, calls, clock } = setup();
    const popup = fakePopup();
    waiter.popupOpened(popup);
    waiter.connected();
    waiter.connected();
    popup.close();
    clock.tick();
    clock.tick();
    expect(calls.count).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  it("settles at once when the card holds no popup", () => {
    const blocked = setup();
    blocked.waiter.popupOpened(null);
    blocked.waiter.connected();
    expect(blocked.calls.count).toBe(1);

    const unclicked = setup();
    unclicked.waiter.connected();
    expect(unclicked.calls.count).toBe(1);
  });

  it("still settles after stop() + resume()", () => {
    const { waiter, calls, clock } = setup();
    const popup = fakePopup();
    waiter.popupOpened(popup);
    waiter.connected();
    waiter.stop();
    expect(clock.pending()).toBe(0);
    waiter.resume();
    popup.close();
    clock.tick();
    expect(calls.count).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  it("does not poll on resume() before any success", () => {
    const { waiter, calls, clock } = setup();
    waiter.resume();
    expect(clock.pending()).toBe(0);
    expect(calls.count).toBe(0);
  });
});

describe("routeCompletion", () => {
  it("settles a failure at once with the popup open, and leaves a retry settleable", () => {
    const { waiter, calls, clock } = setup();
    const failures: (string | undefined)[] = [];
    const popup = fakePopup();
    waiter.popupOpened(popup);
    routeCompletion({ ok: false, error: "denied" }, waiter, (e) => failures.push(e));
    expect(failures).toEqual(["denied"]);
    expect(calls.count).toBe(0);
    expect(clock.pending()).toBe(0);

    // The retry: a fresh popup, then a success.
    const retry = fakePopup();
    waiter.popupOpened(retry);
    routeCompletion({ ok: true }, waiter, (e) => failures.push(e));
    retry.close();
    clock.tick();
    expect(calls.count).toBe(1);
    expect(failures).toHaveLength(1);
  });

  it("holds a success until the popup closes", () => {
    const { waiter, calls, clock } = setup();
    const failures: (string | undefined)[] = [];
    const popup = fakePopup();
    waiter.popupOpened(popup);
    routeCompletion({ ok: true }, waiter, (e) => failures.push(e));
    clock.tick();
    expect(calls.count).toBe(0);
    popup.close();
    clock.tick();
    expect(calls.count).toBe(1);
    expect(failures).toEqual([]);
  });
});
