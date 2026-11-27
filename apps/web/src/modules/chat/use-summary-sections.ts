// SPDX-License-Identifier: Apache-2.0

import { LOCAL_STORAGE_KEYS, createLocalStore, jsonCodec } from "@appstrate/ui/local-storage";
import { toggleValue } from "../../lib/toggle-value";

/** The summary's folding sections. */
export type SummarySectionId = "usage" | "access" | "details";

const openSections = createLocalStore(
  LOCAL_STORAGE_KEYS.chatSummarySections,
  jsonCodec((value): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [],
  ),
);

/**
 * Which of the summary's sections the reader unfolded: all folded at first, so the summary reads
 * at a glance, then as the reader left them, remembered per browser.
 */
export function useSummarySections() {
  const [open, setOpen] = openSections.useValue();
  return {
    isOpen: (id: SummarySectionId) => open.includes(id),
    toggle: (id: SummarySectionId) => setOpen(toggleValue(open, id)),
  };
}
