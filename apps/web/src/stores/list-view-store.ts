// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";
import { persistedScalar } from "./persisted-scalar-store";

export type ListView = "cards" | "table";

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
function createListViewStore(storageKey: string) {
  const parse = (raw: string | null): ListView => (raw === "cards" ? raw : "table");
  return create(persistedScalar(storageKey, parse, "view", "setView"));
}

export const usePackageViewStore = createListViewStore("appstrate-package-view");
export const useIntegrationViewStore = createListViewStore("appstrate-integration-view");
// Operational collections are separate reading tasks. They persist in the
// same way, but changing Documents must not unexpectedly redraw Runs.
export const useDocumentViewStore = createListViewStore("appstrate-document-view");
export const useRunViewStore = createListViewStore("appstrate-run-view");
export const useScheduleViewStore = createListViewStore("appstrate-schedule-view");
