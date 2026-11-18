// SPDX-License-Identifier: Apache-2.0

import * as React from "react";

/**
 * What a phone shows once its on-screen keyboard is up, for the browsers that do not resize the
 * layout viewport for it. Safari on iOS never does: the keyboard shrinks and pans the VISUAL
 * viewport only, so a box sized to `100%`, `vh` or `dvh` keeps its full height and the bottom of
 * it (a chat composer) ends up under the keys. Chrome and Firefox for Android do it when the
 * viewport meta says `interactive-widget=resizes-content` (`index.html`); there the layout
 * viewport and the visual one agree and this reports nothing.
 *
 * The hook publishes two CSS variables on `<html>` only while a keyboard is up:
 * `--keyboard-viewport-height` (the visible height) and `--keyboard-viewport-top` (how far iOS
 * panned the visual viewport down the layout one). A screen that must stay above the keyboard
 * sizes itself `h-[var(--keyboard-viewport-height,100dvh)]` and shifts by
 * `top-[var(--keyboard-viewport-top,0px)]`; with the variables absent both fall back to the
 * browser's own unit.
 */

export const KEYBOARD_VIEWPORT_HEIGHT = "--keyboard-viewport-height";
export const KEYBOARD_VIEWPORT_TOP = "--keyboard-viewport-top";

/** Under this, the difference is the browser's toolbars sliding, not a keyboard. */
const KEYBOARD_MIN_PX = 120;
/** Above this the page is pinch-zoomed, and the visual viewport is smaller on purpose. */
const ZOOMED_SCALE = 1.01;

export interface VisualViewportSample {
  height: number;
  offsetTop: number;
  scale: number;
}

export interface KeyboardViewport {
  height: number;
  top: number;
}

/** The visible area while a keyboard covers part of the layout viewport, else `null`. */
export function keyboardViewport(
  viewport: VisualViewportSample,
  layoutHeight: number,
): KeyboardViewport | null {
  if (viewport.scale > ZOOMED_SCALE) return null;
  if (layoutHeight - viewport.height < KEYBOARD_MIN_PX) return null;
  return { height: Math.round(viewport.height), top: Math.max(0, Math.round(viewport.offsetTop)) };
}

/** What the watcher reads and drives: the browser in production, plain objects in tests. */
export interface KeyboardViewportEnv {
  viewport: VisualViewportSample & {
    addEventListener(type: "resize" | "scroll", listener: () => void): void;
    removeEventListener(type: "resize" | "scroll", listener: () => void): void;
  };
  layoutHeight(): number;
  root: { setProperty(name: string, value: string): void; removeProperty(name: string): void };
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
  setTimer(callback: () => void, ms: number): number;
  clearTimer(id: number): void;
  /** Subscribes to a field losing focus (the keyboard is about to close); returns the unsubscribe. */
  onFocusOut(listener: () => void): () => void;
}

/** After the keyboard closes iOS can leave the visual viewport short: read it again once it is over. */
export const SETTLE_AFTER_FOCUS_OUT_MS = 350;

/**
 * Keeps the two variables in step with the visual viewport; the returned function stops watching
 * and removes them. With no environment (a browser without `visualViewport`) it does nothing.
 */
export function watchKeyboardViewport(env: KeyboardViewportEnv | null): () => void {
  if (!env) return () => {};
  let frame = 0;
  let settle = 0;

  const apply = () => {
    frame = 0;
    const next = keyboardViewport(env.viewport, env.layoutHeight());
    if (next) {
      env.root.setProperty(KEYBOARD_VIEWPORT_HEIGHT, `${next.height}px`);
      env.root.setProperty(KEYBOARD_VIEWPORT_TOP, `${next.top}px`);
    } else {
      env.root.removeProperty(KEYBOARD_VIEWPORT_HEIGHT);
      env.root.removeProperty(KEYBOARD_VIEWPORT_TOP);
    }
  };
  const schedule = () => {
    if (!frame) frame = env.requestFrame(apply);
  };

  apply();
  env.viewport.addEventListener("resize", schedule);
  env.viewport.addEventListener("scroll", schedule);
  const unsubscribeFocusOut = env.onFocusOut(() => {
    env.clearTimer(settle);
    settle = env.setTimer(schedule, SETTLE_AFTER_FOCUS_OUT_MS);
  });
  return () => {
    env.viewport.removeEventListener("resize", schedule);
    env.viewport.removeEventListener("scroll", schedule);
    unsubscribeFocusOut();
    env.cancelFrame(frame);
    env.clearTimer(settle);
    env.root.removeProperty(KEYBOARD_VIEWPORT_HEIGHT);
    env.root.removeProperty(KEYBOARD_VIEWPORT_TOP);
  };
}

/** The browser as a {@link KeyboardViewportEnv}, or `null` without `visualViewport`. */
export function browserKeyboardViewportEnv(): KeyboardViewportEnv | null {
  const viewport = window.visualViewport;
  if (!viewport) return null;
  return {
    viewport,
    layoutHeight: () => window.innerHeight,
    root: document.documentElement.style,
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (id) => cancelAnimationFrame(id),
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: (id) => window.clearTimeout(id),
    onFocusOut: (listener) => {
      window.addEventListener("focusout", listener);
      return () => window.removeEventListener("focusout", listener);
    },
  };
}

/** Keeps the two variables in step with the keyboard while `enabled`; removes them after. */
export function useKeyboardViewport(enabled = true): void {
  React.useEffect(
    () => (enabled ? watchKeyboardViewport(browserKeyboardViewportEnv()) : undefined),
    [enabled],
  );
}
