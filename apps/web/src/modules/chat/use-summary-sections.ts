// SPDX-License-Identifier: Apache-2.0

import { createKeyedLocalStore } from "../../stores/local-storage";
import { toggleValue } from "../../lib/toggle-value";

/** The summary's folding sections. */
export type SummarySectionId = "usage" | "access" | "details";

const openSections = createKeyedLocalStore<string[]>(
  "appstrate:chat-summary-",
  (value) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []),
  [],
);

/**
 * Which of the summary's sections the reader unfolded: all folded at first, so the summary reads
 * at a glance, then as the reader left them, remembered per browser.
 */
export function useSummarySections() {
  const [open, setOpen] = openSections.useValue("open");
  return {
    isOpen: (id: SummarySectionId) => open.includes(id),
    toggle: (id: SummarySectionId) => setOpen(toggleValue(open, id)),
  };
}
