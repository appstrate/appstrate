// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState, type RefObject } from "react";
import { LOCAL_STORAGE_KEYS, createLocalStore } from "@appstrate/ui/local-storage";

/**
 * What the panel shows decides its width: a list stays narrow beside the
 * thread, the details take a little more, a previewed file the most.
 */
export type PanelView = "list" | "detail" | "file";

const PANEL_MIN_WIDTH = 300;
const PANEL_DEFAULT_WIDTH: Record<PanelView, number> = { list: 360, detail: 400, file: 560 };
const PANEL_MAX_RATIO = 0.6;

/** One stored width per view; blocked storage only means the width does not outlive the page. */
const storedWidths = createLocalStore<number | null>(LOCAL_STORAGE_KEYS.chatPanelWidth, {
  parse: (raw) => {
    const value = Number(raw);
    return raw !== null && Number.isFinite(value) && value > 0 ? value : null;
  },
  serialize: (width) => (width === null ? null : String(Math.round(width))),
});

/**
 * The context panel's width on desktop, one per view: remembered per browser,
 * clamped between a floor and a share of the chat area (the parent of
 * `panelRef`'s element, so the panel can never squeeze the thread out).
 */
export function usePanelWidth(panelRef: RefObject<HTMLElement | null>, view: PanelView) {
  const [stored, setStored] = useState<Record<PanelView, number>>(() => ({
    list: storedWidths.read("list") ?? PANEL_DEFAULT_WIDTH.list,
    detail: storedWidths.read("detail") ?? PANEL_DEFAULT_WIDTH.detail,
    file: storedWidths.read("file") ?? PANEL_DEFAULT_WIDTH.file,
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
      storedWidths.write(width, view);
    },
    [view],
  );

  return { width: clamp(stored[view]), min: PANEL_MIN_WIDTH, max, clamp, setLive, commit };
}
