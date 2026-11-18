// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import {
  browserKeyboardViewportEnv,
  KEYBOARD_VIEWPORT_HEIGHT,
  KEYBOARD_VIEWPORT_TOP,
  keyboardViewport,
  SETTLE_AFTER_FOCUS_OUT_MS,
  watchKeyboardViewport,
  type KeyboardViewportEnv,
} from "../src/use-keyboard-viewport.ts";

const phone = { height: 812, offsetTop: 0, scale: 1 };

describe("keyboardViewport", () => {
  it("reports the visible area when a keyboard covers the layout viewport", () => {
    expect(keyboardViewport({ ...phone, height: 478 }, 812)).toEqual({ height: 478, top: 0 });
  });

  it("carries how far iOS panned the visual viewport", () => {
    expect(keyboardViewport({ height: 478, offsetTop: 96.4, scale: 1 }, 812)).toEqual({
      height: 478,
      top: 96,
    });
  });

  it("reports nothing when the layout viewport already follows the keyboard", () => {
    expect(keyboardViewport({ ...phone, height: 478 }, 478)).toBeNull();
  });

  it("reports nothing without a keyboard", () => {
    expect(keyboardViewport(phone, 812)).toBeNull();
  });

  it("ignores the browser toolbars sliding in and out", () => {
    expect(keyboardViewport({ ...phone, height: 760 }, 812)).toBeNull();
  });

  it("ignores a pinch-zoomed page, whose visual viewport is smaller on purpose", () => {
    expect(keyboardViewport({ height: 406, offsetTop: 0, scale: 2 }, 812)).toBeNull();
  });

  it("never returns a negative offset", () => {
    expect(keyboardViewport({ height: 478, offsetTop: -3, scale: 1 }, 812)?.top).toBe(0);
  });
});

/** Plain objects standing in for the browser: a visual viewport, the root's style, frames and timers. */
function fakeBrowser(sample: { height: number; offsetTop?: number; scale?: number }, layout = 812) {
  const listeners: Record<string, Set<() => void>> = { resize: new Set(), scroll: new Set() };
  const focusOut = new Set<() => void>();
  const vars = new Map<string, string>();
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let nextId = 1;
  const viewport = {
    height: sample.height,
    offsetTop: sample.offsetTop ?? 0,
    scale: sample.scale ?? 1,
    addEventListener: (type: "resize" | "scroll", listener: () => void) =>
      listeners[type]!.add(listener),
    removeEventListener: (type: "resize" | "scroll", listener: () => void) =>
      listeners[type]!.delete(listener),
  };
  const env: KeyboardViewportEnv = {
    viewport,
    layoutHeight: () => layout,
    root: {
      setProperty: (name, value) => void vars.set(name, value),
      removeProperty: (name) => void vars.delete(name),
    },
    requestFrame: (callback) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => void frames.delete(id),
    setTimer: (callback, ms) => {
      const id = nextId++;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimer: (id) => void timers.delete(id),
    onFocusOut: (listener) => {
      focusOut.add(listener);
      return () => focusOut.delete(listener);
    },
  };
  const fire = (type: "resize" | "scroll") => listeners[type]!.forEach((listener) => listener());
  const runFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback());
  };
  const runTimers = () => {
    const pending = [...timers.values()];
    timers.clear();
    pending.forEach(({ callback }) => callback());
  };
  return { viewport, env, vars, frames, timers, focusOut, listeners, fire, runFrames, runTimers };
}

describe("watchKeyboardViewport", () => {
  it("publishes the visible area at once when a keyboard is already up", () => {
    const browser = fakeBrowser({ height: 478, offsetTop: 96 });
    watchKeyboardViewport(browser.env);
    expect(browser.vars.get(KEYBOARD_VIEWPORT_HEIGHT)).toBe("478px");
    expect(browser.vars.get(KEYBOARD_VIEWPORT_TOP)).toBe("96px");
  });

  it("publishes nothing without a keyboard", () => {
    const browser = fakeBrowser({ height: 812 });
    watchKeyboardViewport(browser.env);
    expect(browser.vars.size).toBe(0);
  });

  it("follows the keyboard opening and closing, one frame after the event", () => {
    const browser = fakeBrowser({ height: 812 });
    watchKeyboardViewport(browser.env);
    browser.viewport.height = 478;
    browser.fire("resize");
    expect(browser.vars.size).toBe(0);
    browser.runFrames();
    expect(browser.vars.get(KEYBOARD_VIEWPORT_HEIGHT)).toBe("478px");
    browser.viewport.height = 812;
    browser.fire("resize");
    browser.runFrames();
    expect(browser.vars.size).toBe(0);
  });

  it("follows the pan of the visual viewport (scroll)", () => {
    const browser = fakeBrowser({ height: 478 });
    watchKeyboardViewport(browser.env);
    browser.viewport.offsetTop = 120;
    browser.fire("scroll");
    browser.runFrames();
    expect(browser.vars.get(KEYBOARD_VIEWPORT_TOP)).toBe("120px");
  });

  it("coalesces a burst of events into one frame", () => {
    const browser = fakeBrowser({ height: 812 });
    watchKeyboardViewport(browser.env);
    browser.fire("resize");
    browser.fire("scroll");
    browser.fire("resize");
    expect(browser.frames.size).toBe(1);
  });

  it("reads the viewport again once the keyboard animation is over, after a field loses focus", () => {
    const browser = fakeBrowser({ height: 478 });
    watchKeyboardViewport(browser.env);
    browser.viewport.height = 812;
    browser.focusOut.forEach((listener) => listener());
    expect([...browser.timers.values()].map((timer) => timer.ms)).toEqual([
      SETTLE_AFTER_FOCUS_OUT_MS,
    ]);
    browser.runTimers();
    browser.runFrames();
    expect(browser.vars.size).toBe(0);
  });

  it("restarts the wait when focus is lost twice in a row", () => {
    const browser = fakeBrowser({ height: 812 });
    watchKeyboardViewport(browser.env);
    browser.focusOut.forEach((listener) => listener());
    browser.focusOut.forEach((listener) => listener());
    expect(browser.timers.size).toBe(1);
  });

  it("stops watching, cancels what is pending and removes the variables on cleanup", () => {
    const browser = fakeBrowser({ height: 478 });
    const stop = watchKeyboardViewport(browser.env);
    browser.fire("resize");
    browser.focusOut.forEach((listener) => listener());
    stop();
    expect(browser.listeners.resize!.size).toBe(0);
    expect(browser.listeners.scroll!.size).toBe(0);
    expect(browser.focusOut.size).toBe(0);
    expect(browser.frames.size).toBe(0);
    expect(browser.timers.size).toBe(0);
    expect(browser.vars.size).toBe(0);
  });

  it("does nothing in a browser without visualViewport", () => {
    expect(() => watchKeyboardViewport(null)()).not.toThrow();
  });
});

describe("browserKeyboardViewportEnv", () => {
  const original = {
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    raf: Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame"),
    caf: Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame"),
  };
  const restore = (name: string, descriptor: PropertyDescriptor | undefined) => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  };
  const install = (windowValue: object) => {
    const style = { setProperty: () => {}, removeProperty: () => "" };
    const cleared: number[] = [];
    Object.defineProperty(globalThis, "window", { value: windowValue, configurable: true });
    Object.defineProperty(globalThis, "document", {
      value: { documentElement: { style } },
      configurable: true,
    });
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      value: (callback: () => void) => {
        callback();
        return 7;
      },
      configurable: true,
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      value: (id: number) => void cleared.push(id),
      configurable: true,
    });
    return { style, cleared };
  };
  afterEach(() => {
    restore("window", original.window);
    restore("document", original.document);
    restore("requestAnimationFrame", original.raf);
    restore("cancelAnimationFrame", original.caf);
  });

  it("is null without visualViewport", () => {
    install({ visualViewport: null });
    expect(browserKeyboardViewportEnv()).toBeNull();
  });

  it("reads and drives the real window and document", () => {
    const events: string[] = [];
    const timers: number[] = [];
    const visual = { height: 478, offsetTop: 0, scale: 1 };
    const { style, cleared } = install({
      visualViewport: visual,
      innerHeight: 812,
      setTimeout: (callback: () => void, ms: number) => {
        callback();
        timers.push(ms);
        return 3;
      },
      clearTimeout: (id: number) => void events.push(`clear:${id}`),
      addEventListener: (type: string) => void events.push(`add:${type}`),
      removeEventListener: (type: string) => void events.push(`remove:${type}`),
    });
    const env = browserKeyboardViewportEnv()!;
    expect(env.viewport).toBe(visual as unknown as typeof env.viewport);
    expect(env.layoutHeight()).toBe(812);
    expect(env.root).toBe(style as unknown as typeof env.root);
    let framed = 0;
    expect(env.requestFrame(() => void framed++)).toBe(7);
    expect(framed).toBe(1);
    env.cancelFrame(7);
    expect(cleared).toEqual([7]);
    env.setTimer(() => {}, 350);
    expect(timers).toEqual([350]);
    env.clearTimer(3);
    const unsubscribe = env.onFocusOut(() => {});
    unsubscribe();
    expect(events).toEqual(["clear:3", "add:focusout", "remove:focusout"]);
  });
});
