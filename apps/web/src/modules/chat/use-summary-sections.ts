// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";

/** The summary's folding sections. */
export type SummarySectionId = "runs" | "files" | "tools" | "usage" | "access" | "details";

const STORAGE_KEY = "appstrate:chat-summary-open";

function readOpen(): Set<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function storeOpen(open: ReadonlySet<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...open]));
  } catch {
    // Private mode or blocked storage: the sections just fold again on the next page.
  }
}

/**
 * Which of the summary's sections the reader unfolded: all folded at first, so the summary reads
 * at a glance, then as the reader left them, remembered per browser.
 */
export function useSummarySections() {
  const [open, setOpen] = useState<ReadonlySet<string>>(readOpen);
  useEffect(() => storeOpen(open), [open]);
  return {
    isOpen: (id: SummarySectionId) => open.has(id),
    setOpen: (id: SummarySectionId, next: boolean) =>
      setOpen((current) => {
        const updated = new Set(current);
        if (next) updated.add(id);
        else updated.delete(id);
        return updated;
      }),
  };
}
