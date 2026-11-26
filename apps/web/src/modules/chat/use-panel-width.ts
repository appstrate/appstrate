// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState, type RefObject } from "react";

/**
 * What the panel shows decides its width: a list stays narrow beside the
 * thread, the details take a little more, a previewed file the most.
 */
export type PanelView = "list" | "detail" | "file";

const STORAGE_KEY = "appstrate:chat-context-width";
const PANEL_MIN_WIDTH = 300;
const PANEL_DEFAULT_WIDTH: Record<PanelView, number> = { list: 360, detail: 400, file: 560 };
const PANEL_MAX_RATIO = 0.6;

const storageKey = (view: PanelView) => `${STORAGE_KEY}:${view}`;

function readStoredWidth(view: PanelView): number | null {
  try {
    const value = Number(localStorage.getItem(storageKey(view)));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function storeWidth(view: PanelView, width: number | null) {
  try {
    if (width === null) localStorage.removeItem(storageKey(view));
    else localStorage.setItem(storageKey(view), String(Math.round(width)));
  } catch {
    // Private mode or blocked storage: the width just does not outlive the page.
  }
}

/**
 * The context panel's width on desktop, one per view: remembered per browser,
 * clamped between a floor and a share of the chat area (the parent of
 * `panelRef`'s element, so the panel can never squeeze the thread out).
 */
export function usePanelWidth(panelRef: RefObject<HTMLElement | null>, view: PanelView) {
  const [stored, setStored] = useState<Record<PanelView, number>>(() => ({
    list: readStoredWidth("list") ?? PANEL_DEFAULT_WIDTH.list,
    detail: readStoredWidth("detail") ?? PANEL_DEFAULT_WIDTH.detail,
    file: readStoredWidth("file") ?? PANEL_DEFAULT_WIDTH.file,
  }));
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
  const setLive = useCallback(
    (width: number) => setStored((current) => ({ ...current, [view]: width })),
    [view],
  );
  const commit = useCallback(
    (width: number | null) => {
      setStored((current) => ({ ...current, [view]: width ?? PANEL_DEFAULT_WIDTH[view] }));
      storeWidth(view, width);
    },
    [view],
  );

  return { width: clamp(stored[view]), min: PANEL_MIN_WIDTH, max, clamp, setLive, commit };
}
