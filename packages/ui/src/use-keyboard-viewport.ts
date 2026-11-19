// SPDX-License-Identifier: Apache-2.0

import * as React from "react";

// Some browsers pan and shrink only the visual viewport when the keyboard opens.
// When the layout viewport already resizes, the chat keeps its CSS height.
const KEYBOARD_VIEWPORT_HEIGHT = "--keyboard-viewport-height";
const KEYBOARD_VIEWPORT_TOP = "--keyboard-viewport-top";

/** Shared by the chat shell and its independently positioned sidebar. */
export const KEYBOARD_VIEWPORT_CLASS =
  "top-[var(--keyboard-viewport-top,0px)] h-[var(--keyboard-viewport-height,100dvh)]";

/** Under this, the difference is the browser's toolbars sliding, not a keyboard. */
const KEYBOARD_MIN_PX = 120;
// Landscape Safari with its tab and keyboard accessory bars can report even a negative height.
// Below one editable row, let Safari pan the layout to the caret.
const MIN_EDITABLE_HEIGHT = 36;
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
  if (viewport.scale > ZOOMED_SCALE || viewport.height < MIN_EDITABLE_HEIGHT) return null;
  if (layoutHeight - viewport.height < KEYBOARD_MIN_PX) return null;
  return { height: Math.round(viewport.height), top: Math.max(0, Math.round(viewport.offsetTop)) };
}

/** Keeps the two variables in step with the keyboard while `enabled`; removes them after. */
export function useKeyboardViewport(enabled = true): void {
  React.useEffect(() => {
    const viewport = window.visualViewport;
    if (!enabled || !viewport) return;
    const root = document.documentElement;
    let frame = 0;
    let settle = 0;

    const apply = () => {
      frame = 0;
      const next = keyboardViewport(viewport, window.innerHeight);
      if (next) {
        root.style.setProperty(KEYBOARD_VIEWPORT_HEIGHT, `${next.height}px`);
        root.style.setProperty(KEYBOARD_VIEWPORT_TOP, `${next.top}px`);
      } else {
        root.style.removeProperty(KEYBOARD_VIEWPORT_HEIGHT);
        root.style.removeProperty(KEYBOARD_VIEWPORT_TOP);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    // iOS can leave the visual viewport short after the keyboard closes: read it again once the
    // keyboard animation is over.
    const onFocusOut = () => {
      window.clearTimeout(settle);
      settle = window.setTimeout(schedule, 350);
    };

    apply();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    window.addEventListener("focusout", onFocusOut);
    return () => {
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("focusout", onFocusOut);
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      root.style.removeProperty(KEYBOARD_VIEWPORT_HEIGHT);
      root.style.removeProperty(KEYBOARD_VIEWPORT_TOP);
    };
  }, [enabled]);
}
