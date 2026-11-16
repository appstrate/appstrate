// SPDX-License-Identifier: Apache-2.0

import { useLayoutEffect, useState, type RefObject } from "react";

/** Below this, the surface keeps a usable height and the page scrolls instead. */
const MIN_HEIGHT = 320;

/**
 * The height at which `ref`'s element ends where the shell's scrolling `<main>` ends, keeping
 * what the page draws under it (its bottom padding) in view: a surface that scrolls inside
 * itself without making the page scroll too. `undefined` until measured, and outside `<main>`.
 */
export function useFillHeight(ref: RefObject<HTMLElement | null>): number | undefined {
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const el = ref.current;
    const page = el?.closest("main");
    if (!el || !page) return;
    // The page column holding the element: sized by its content, so its bottom is the page's end.
    let column: HTMLElement = el;
    while (column.parentElement && column.parentElement !== page) column = column.parentElement;
    const measure = () => {
      const box = el.getBoundingClientRect();
      const top = box.top - page.getBoundingClientRect().top + page.scrollTop;
      const below = column.getBoundingClientRect().bottom - box.bottom;
      setHeight(Math.max(MIN_HEIGHT, Math.floor(page.clientHeight - top - below)));
    };
    measure();
    // The header, a banner or the content above the element moving it, or the window resizing.
    const observer = new ResizeObserver(measure);
    observer.observe(page);
    for (const child of page.children) observer.observe(child);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}
