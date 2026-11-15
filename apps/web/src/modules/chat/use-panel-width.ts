// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState, type RefObject } from "react";

const STORAGE_KEY = "appstrate:chat-context-width";
const PANEL_MIN_WIDTH = 320;
const PANEL_DEFAULT_WIDTH = 480;
const PANEL_MAX_RATIO = 0.6;

function readStoredWidth(): number | null {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function storeWidth(width: number | null) {
  try {
    if (width === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Private mode or blocked storage: the width just does not outlive the page.
  }
}

/**
 * The context panel's width on desktop: remembered per browser, clamped between
 * a floor and a share of the chat area (the parent of `panelRef`'s element, so
 * the panel can never squeeze the thread out).
 */
export function usePanelWidth(panelRef: RefObject<HTMLElement | null>) {
  const [stored, setStored] = useState(() => readStoredWidth() ?? PANEL_DEFAULT_WIDTH);
  const [areaWidth, setAreaWidth] = useState(0);

  useEffect(() => {
    const area = panelRef.current?.parentElement;
    if (!area) return;
    const observer = new ResizeObserver(() => setAreaWidth(area.clientWidth));
    observer.observe(area);
    return () => observer.disconnect();
  }, [panelRef]);

  // Before the first measure the area is unknown: do not clamp against 0.
  const max = areaWidth > 0 ? Math.max(PANEL_MIN_WIDTH, areaWidth * PANEL_MAX_RATIO) : Infinity;
  const clamp = useCallback(
    (width: number) => Math.min(Math.max(width, PANEL_MIN_WIDTH), max),
    [max],
  );
  const commit = useCallback((width: number | null) => {
    setStored(width ?? PANEL_DEFAULT_WIDTH);
    storeWidth(width);
  }, []);

  return { width: clamp(stored), min: PANEL_MIN_WIDTH, max, clamp, setLive: setStored, commit };
}
