// SPDX-License-Identifier: Apache-2.0

/**
 * A Back blocked by the unsaved-changes guard pushes the editor's entry back.
 * It must carry that entry's router state (`idx`, `key`, `usr`): the overlay
 * close step and `useUrlModal` read it, and a `null` state turns a later
 * modal close into a replace instead of a Back.
 */

import { describe, expect, it } from "bun:test";
import { undoLeavingPop } from "../use-unsaved-changes.ts";

const origin = "https://app.test";
const noPlace = () => "";

function recorder() {
  const calls: Array<{ state: unknown; url: string | URL | null | undefined }> = [];
  const push = (state: unknown, _unused: string, url?: string | URL | null) => {
    calls.push({ state, url });
  };
  return { calls, push };
}

describe("undoLeavingPop", () => {
  it("re-pushes the editor's entry with its router state and answers the target", () => {
    const { calls, push } = recorder();
    const state = { idx: 4, key: "k4", usr: { openedModal: true } };
    const to = undoLeavingPop(
      { path: "/agents/@acme/worker#settings", state },
      `${origin}/agents?q=x`,
      noPlace,
      push,
    );
    expect(to).toBe("/agents?q=x");
    expect(calls).toEqual([{ state, url: "/agents/@acme/worker#settings" }]);
  });

  it("CONTROL: lets a pop that keeps the editor mounted through", () => {
    const { calls, push } = recorder();
    const to = undoLeavingPop(
      { path: "/agents/@acme/worker?package=@acme/x", state: { idx: 2 } },
      `${origin}/agents/@acme/worker`,
      noPlace,
      push,
    );
    expect(to).toBeNull();
    expect(calls).toEqual([]);
  });
});
