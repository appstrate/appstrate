// SPDX-License-Identifier: Apache-2.0

/**
 * The trail the shell header renders. Pages DECLARE breadcrumbs, the header
 * draws them once. Each surface owns its own layer so no writer wipes another's
 * trail; a layer remembers its writer and a writer clears it on unmount only
 * while it still owns it.
 */
import { useEffect, useId } from "react";
import { createStore } from "zustand/vanilla";

export interface BreadcrumbEntry {
  label: string;
  href?: string;
  /** The header draws an empty slot; the page fills it via `ShellTrailContent` (a portal keeps the page's context). */
  slot?: true;
}

/** `overlay` is the open overlay's own trail; `overlayPage` what a page inside it appends. */
export type BreadcrumbLayer = "page" | "overlay" | "overlayPage";

interface Slot {
  owner: string | null;
  entries: BreadcrumbEntry[];
}

type Layers = Record<BreadcrumbLayer, Slot>;

interface BreadcrumbState extends Layers {
  publish: (layer: BreadcrumbLayer, owner: string, entries: BreadcrumbEntry[]) => void;
  clear: (layer: BreadcrumbLayer, owner: string) => void;
}

const EMPTY: Slot = { owner: null, entries: [] };

function sameEntries(a: BreadcrumbEntry[], b: BreadcrumbEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every((entry, i) => {
      const other = b[i]!;
      return entry.label === other.label && entry.href === other.href && entry.slot === other.slot;
    })
  );
}

export const breadcrumbStore = createStore<BreadcrumbState>((set, get) => ({
  page: EMPTY,
  overlay: EMPTY,
  overlayPage: EMPTY,
  publish: (layer, owner, entries) => {
    const slot = get()[layer];
    if (slot.owner === owner && sameEntries(slot.entries, entries)) return;
    set({ [layer]: { owner, entries } });
  },
  clear: (layer, owner) => {
    if (get()[layer].owner === owner) set({ [layer]: EMPTY });
  },
}));

/** What the header shows: the overlay's trail while one is open, else the page's. */
export function visibleTrail(layers: Layers, overlayOpen: boolean): BreadcrumbEntry[] {
  return overlayOpen
    ? [...layers.overlay.entries, ...layers.overlayPage.entries]
    : layers.page.entries;
}

/** Publishes `entries` on every render (callers rebuild the array, hence no dependency list); unchanged entries are a no-op. */
export function useBreadcrumb(layer: BreadcrumbLayer, entries: BreadcrumbEntry[]) {
  const owner = useId();
  const { publish, clear } = breadcrumbStore.getState();
  useEffect(() => {
    publish(layer, owner, entries);
  });
  useEffect(() => () => clear(layer, owner), [clear, layer, owner]);
}
