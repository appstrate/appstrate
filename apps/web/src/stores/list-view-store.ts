// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";

export type ListView = "cards" | "table";

interface ListViewState {
  view: ListView;
  setView: (view: ListView) => void;
}

/**
 * Whether a list is drawn as cards or as a table, remembered across reloads.
 *
 * A preference, not a location, so it stays out of the URL: a link to a
 * filtered list should open on the reader's own habit rather than impose the
 * sender's. Same reasoning — and the same shape — as the sidebar's open state.
 *
 * One store per FAMILY of list rather than per screen: agents, skills and MCP
 * servers are the same catalogue rendered three times, and someone who wants
 * the table for one wants it for the others.
 */
function createListViewStore(storageKey: string, defaultView: ListView = "cards") {
  const stored = localStorage.getItem(storageKey);
  return create<ListViewState>()((set) => ({
    view: stored === "cards" || stored === "table" ? stored : defaultView,
    setView: (view) => {
      localStorage.setItem(storageKey, view);
      set({ view });
    },
  }));
}

export const usePackageViewStore = createListViewStore("appstrate-package-view", "table");
export const useIntegrationViewStore = createListViewStore("appstrate-integration-view", "table");
// Operational collections are separate reading tasks. They persist in the
// same way, but changing Documents must not unexpectedly redraw Runs.
export const useDocumentViewStore = createListViewStore("appstrate-document-view", "table");
export const useRunViewStore = createListViewStore("appstrate-run-view", "table");
export const useScheduleViewStore = createListViewStore("appstrate-schedule-view", "table");
