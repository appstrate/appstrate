// SPDX-License-Identifier: Apache-2.0

/**
 * When the connect card settles. The case that matters: a platform-provisioned
 * credential (SSH) whose connection row — and so its SSE `connection_update` —
 * exists while the popup is still showing the install block. Resuming then
 * would send the agent at a host that does not trust the key yet.
 */

import { describe, it, expect } from "bun:test";
import { createConnectWaiter, type Every, type PopupHandle } from "../src/ui/connect-waiter.ts";

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
  const calls: Array<{ ok: boolean; error?: string }> = [];
  const waiter = createConnectWaiter(clock.every);
  waiter.bind((ok, error) => calls.push({ ok, error }));
  return { waiter, calls, clock };
}

describe("createConnectWaiter", () => {
  it("does not resume on an SSE hit while the popup is still open", () => {
    const { waiter, calls, clock } = setup();
    waiter.popupOpened(fakePopup());
    waiter.connectionSeen();
    clock.tick();
    clock.tick();
    expect(calls).toEqual([]);
  });

  it("resumes on the completion message, SSE hit or not, and stops polling", () => {
    const { waiter, calls, clock } = setup();
    const popup = fakePopup();
    waiter.popupOpened(popup);
    waiter.connectionSeen();
    waiter.completion({ ok: true, packageId: "@appstrate/ssh" });
    expect(calls).toEqual([{ ok: true, error: undefined }]);
    expect(clock.pending()).toBe(0);
    // The page closes itself after announcing; nothing settles a second time.
    popup.close();
    waiter.connectionSeen();
    clock.tick();
    expect(calls).toHaveLength(1);
  });

  it("resumes on a parked SSE hit once the popup closes", () => {
    const { waiter, calls, clock } = setup();
    const popup = fakePopup();
    waiter.popupOpened(popup);
    waiter.connectionSeen();
    popup.close();
    clock.tick();
    expect(calls).toEqual([{ ok: true, error: undefined }]);
    expect(clock.pending()).toBe(0);
  });

  it("resumes at once on an SSE hit that arrives after the popup closed", () => {
    const { waiter, calls } = setup();
    const popup = fakePopup();
    waiter.popupOpened(popup);
    popup.close();
    waiter.connectionSeen();
    expect(calls).toEqual([{ ok: true, error: undefined }]);
  });

  it("resumes at once on an SSE hit when the card opened no popup", () => {
    const blocked = setup();
    blocked.waiter.popupOpened(null);
    blocked.waiter.connectionSeen();
    expect(blocked.calls).toEqual([{ ok: true, error: undefined }]);

    // Never clicked: the user followed a pasted link in another tab.
    const unclicked = setup();
    unclicked.waiter.connectionSeen();
    expect(unclicked.calls).toEqual([{ ok: true, error: undefined }]);
  });

  it("resumes a parked SSE hit after stop(), settling once the popup closes", () => {
    const { waiter, calls, clock } = setup();
    const popup = fakePopup();
    waiter.popupOpened(popup);
    waiter.connectionSeen();
    waiter.stop();
    expect(clock.pending()).toBe(0);
    waiter.resume();
    expect(calls).toEqual([]);
    popup.close();
    clock.tick();
    clock.tick();
    expect(calls).toEqual([{ ok: true, error: undefined }]);
    expect(clock.pending()).toBe(0);
  });

  it("does not poll on resume() before any SSE hit", () => {
    const { waiter, calls, clock } = setup();
    waiter.resume();
    expect(clock.pending()).toBe(0);
    expect(calls).toEqual([]);
  });

  it("keeps a failed completion retryable", () => {
    const { waiter, calls } = setup();
    waiter.completion({ ok: false, error: "denied" });
    waiter.completion({ ok: true });
    expect(calls).toEqual([
      { ok: false, error: "denied" },
      { ok: true, error: undefined },
    ]);
  });
});
