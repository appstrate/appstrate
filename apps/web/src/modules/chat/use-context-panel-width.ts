// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState, type RefObject } from "react";
import { LOCAL_STORAGE_KEYS } from "@appstrate/ui/local-storage";
import { createPanelWidthStore } from "../../stores/panel-width-store";

const MIN_WIDTH = 300;
const DEFAULT_WIDTH = 400;
const MAX_RATIO = 0.6;

const useContextPanelWidthStore = createPanelWidthStore(
  LOCAL_STORAGE_KEYS.chatPanelWidth,
  (width) => Math.max(width, MIN_WIDTH),
);

/**
 * The context panel's width on desktop, one whatever it shows: remembered per browser, clamped
 * between a floor and a share of the chat area (the parent of `panelRef`'s element, so the panel
 * can never squeeze the thread out).
 */
export function useContextPanelWidth(panelRef: RefObject<HTMLElement | null>) {
  const { width, dragging, setLive, commit, setDragging } = useContextPanelWidthStore();
  const [areaWidth, setAreaWidth] = useState(0);

  useEffect(() => {
    const area = panelRef.current?.parentElement;
    if (!area) return;
    const observer = new ResizeObserver(() => setAreaWidth(area.clientWidth));
    observer.observe(area);
    return () => observer.disconnect();
  }, [panelRef]);

  // Before the first measure the area is unknown: do not clamp against 0.
  const max = areaWidth > 0 ? Math.max(MIN_WIDTH, areaWidth * MAX_RATIO) : Infinity;
  const clamp = useCallback((next: number) => Math.min(Math.max(next, MIN_WIDTH), max), [max]);

  return {
    width: clamp(width ?? DEFAULT_WIDTH),
    min: MIN_WIDTH,
    max,
    clamp,
    dragging,
    setLive,
    commit,
    setDragging,
  };
}
