// SPDX-License-Identifier: Apache-2.0

/**
 * `useChangeAnnouncement` mounted for real: a live region's text stays silent on the state a view
 * opens on and speaks only a later change. There is no DOM harness in this repo; a probe rendering
 * nothing needs only the few globals react-dom's client touches, installed for this file.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useChangeAnnouncement } from "../src/ui/use-change-announcement.ts";

const globals = globalThis as { window?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean };
const saved = { window: globals.window, act: globals.IS_REACT_ACT_ENVIRONMENT };
const noop = () => {};
const doc: Record<string, unknown> = {
  addEventListener: noop,
  removeEventListener: noop,
  activeElement: null,
};
function container() {
  const node = {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    addEventListener: noop,
    removeEventListener: noop,
    ownerDocument: doc,
  };
  doc.documentElement = doc.body = node;
  return node as unknown as HTMLElement;
}

beforeAll(() => {
  globals.window = { HTMLIFrameElement: class {}, document: doc };
  globals.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  if (saved.window === undefined) delete globals.window;
  else globals.window = saved.window;
  globals.IS_REACT_ACT_ENVIRONMENT = saved.act;
});

/** Mounts the hook; `update` re-renders it with new inputs, `read` is what it last returned. */
function mount(text: string, ready: boolean) {
  let last = "";
  function Probe({ text, ready }: { text: string; ready: boolean }) {
    last = useChangeAnnouncement(text, ready);
    return null;
  }
  const root = createRoot(container());
  act(() => root.render(<Probe text={text} ready={ready} />));
  return {
    update: (next: string, nextReady = true) =>
      act(() => root.render(<Probe text={next} ready={nextReady} />)),
    read: () => last,
    unmount: () => act(() => root.unmount()),
  };
}

describe("useChangeAnnouncement", () => {
  it("stays silent on the state the view opens on, however late it is ready", () => {
    const probe = mount("", false);
    expect(probe.read()).toBe("");
    probe.update("Alpha");
    expect(probe.read()).toBe("");
    probe.update("Alpha");
    expect(probe.read()).toBe("");
    probe.unmount();
  });

  it("reads out every later change, once the text differs from the opening one", () => {
    const probe = mount("Alpha", true);
    expect(probe.read()).toBe("");
    probe.update("2 skills");
    expect(probe.read()).toBe("2 skills");
    // Back to the opening text is a change too: the region says it.
    probe.update("Alpha");
    expect(probe.read()).toBe("Alpha");
    probe.unmount();
  });

  it("takes the opening state from the first ready render, not from before", () => {
    const probe = mount("stale", false);
    probe.update("", true);
    expect(probe.read()).toBe("");
    probe.update("Alpha");
    expect(probe.read()).toBe("Alpha");
    probe.unmount();
  });
});
