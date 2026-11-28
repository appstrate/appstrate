// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";

/** The open item's disclosure trigger inside `container` (Base UI marks it `data-panel-open`). */
export function openItemTrigger(container: ParentNode | null): HTMLElement | null {
  return container?.querySelector<HTMLElement>("[data-open-item] [data-panel-open]") ?? null;
}

/**
 * Props for a Runs or Tools item's disclosure root: once open it scrolls into view and its trigger takes the
 * focus, so an item opened from the thread, the summary or a missed reveal is in sight and reached.
 */
export function useOpenItem(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!open || !root) return;
    root.scrollIntoView({ block: "nearest" });
    root.querySelector<HTMLElement>("[data-panel-open]")?.focus({ preventScroll: true });
  }, [open]);
  return { ref, "data-open-item": open ? "" : undefined };
}
